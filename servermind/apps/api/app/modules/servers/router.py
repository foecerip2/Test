from __future__ import annotations

import asyncio
import datetime as dt
from collections.abc import Coroutine
from typing import Any, TypeVar

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.auth import AuthContext, client_ip, get_ctx, utcnow
from app.core.config import get_settings
from app.core.permissions import ApiError, get_server_or_404, require_role
from app.core.security import DecryptionError, SlidingWindowLimiter, consteq, decrypt, encrypt
from app.db.models import Server, ServerCredential, ServerMetricSample
from app.db.session import get_db
from app.modules.audit import service as audit
from app.modules.servers import ssh
from app.modules.servers.policy import HostPolicyError, check_username, resolve_target
from app.modules.servers.schemas import (
    AddServerIn,
    MetricPoint,
    MetricsOut,
    ProbeIn,
    ProbeOut,
    PublicKeyOut,
    ServerOut,
    ServiceOut,
    VerifyOut,
)

router = APIRouter(prefix="/servers", tags=["servers"])
T = TypeVar("T")
_limiter: SlidingWindowLimiter | None = None
_KEY_KIND = "ssh_private_key"


def _run(coro: Coroutine[Any, Any, T]) -> T:
    return asyncio.run(coro)


def _guard(ctx: AuthContext) -> None:
    """Исходящие SSH-операции — вектор злоупотребления: ограничиваем частоту на пользователя."""
    global _limiter
    s = get_settings()
    if _limiter is None or _limiter.limit != s.ssh_ops_per_minute:
        _limiter = SlidingWindowLimiter(s.ssh_ops_per_minute, 60)
    if not _limiter.allow(str(ctx.user.id)):
        raise ApiError(429, "rate_limited", "Слишком много проверок подряд. Подождите минуту.")


def reset_limiter() -> None:
    global _limiter
    _limiter = None


_HTTP_FOR = {"host_key_changed": 409, "auth_failed": 422, "timeout": 504, "unreachable": 502}


def _ssh_http(e: ssh.SshError) -> ApiError:
    return ApiError(_HTTP_FOR.get(e.code, 502), e.code, e.message)


def _target(host: str, port: int) -> tuple[str, str]:
    try:
        return resolve_target(host, port)
    except HostPolicyError as e:
        raise ApiError(422, e.code, e.message) from None


def _aad(org_id: Any) -> bytes:
    return f"cred:{org_id}:{_KEY_KIND}".encode()


def _org_key(db: Session, ctx: AuthContext, *, create: bool) -> tuple[str, str] | None:
    """(public, private_pem) ключа сервиса организации. Приватный хранится только зашифрованным (AEAD + привязка к org)."""
    s = get_settings()
    row = db.scalar(select(ServerCredential).where(
        ServerCredential.organization_id == ctx.org_id, ServerCredential.kind == _KEY_KIND, ServerCredential.server_id.is_(None)))
    if row is None:
        if not create:
            return None
        private, public = ssh.generate_service_key(f"servermind-{str(ctx.org_id)[:8]}")
        row = ServerCredential(organization_id=ctx.org_id, kind=_KEY_KIND, public_key=public,
                               ciphertext=encrypt(s.master_key_bytes, private.encode(), _aad(ctx.org_id)))
        db.add(row)
        audit.record(db, "ssh_key.generated", org_id=ctx.org_id, actor_id=ctx.user.id, target=row.kind, ip="")
        db.commit()
    try:
        return row.public_key, decrypt(s.master_key_bytes, row.ciphertext, _aad(ctx.org_id)).decode()
    except DecryptionError:
        raise ApiError(500, "crypto", "Не удалось расшифровать ключ сервиса. Проверьте ENCRYPTION_MASTER_KEY.") from None


def _latest(db: Session, server: Server) -> ServerMetricSample | None:
    return db.scalar(select(ServerMetricSample).where(ServerMetricSample.server_id == server.id)
                     .order_by(ServerMetricSample.sampled_at.desc()).limit(1))


def _out(db: Session, server: Server) -> ServerOut:
    s = _latest(db, server)
    services = [ServiceOut(name=x["name"], state=x["state"]) for x in (s.services if s else [])]
    return ServerOut(
        id=str(server.id), name=server.name, host=server.host, port=server.port, username=server.username,
        os=(s.os if s and s.os else server.os), status=server.status, last_checked_at=server.last_checked_at,
        last_success_at=server.last_success_at, uptime_seconds=s.uptime_seconds if s else None,
        cpu_percent=s.cpu_percent if s else None, ram_used_mb=s.ram_used_mb if s else None,
        ram_total_mb=s.ram_total_mb if s else None, disk_used_gb=s.disk_used_gb if s else None,
        disk_total_gb=s.disk_total_gb if s else None, fingerprint=server.fingerprint, services=services,
    )


def _store(db: Session, server: Server, facts: ssh.Facts, now: dt.datetime) -> None:
    server.status, server.last_error_code = "online", None
    server.last_checked_at = server.last_success_at = now
    server.os = facts.os or server.os
    db.add(ServerMetricSample(
        organization_id=server.organization_id, server_id=server.id, sampled_at=now, os=facts.os,
        uptime_seconds=facts.uptime_seconds, cpu_percent=facts.cpu_percent, ram_used_mb=facts.ram_used_mb,
        ram_total_mb=facts.ram_total_mb, disk_used_gb=facts.disk_used_gb, disk_total_gb=facts.disk_total_gb,
        services=[{"name": n, "state": st} for n, st in facts.services],
    ))


def _collect(server: Server, ip: str, key: tuple[str, str]) -> ssh.Facts:
    s = get_settings()
    try:
        return _run(ssh.collect_facts(
            ip, server.port, server.username, key[1], server.host_key_openssh,
            connect_timeout=s.ssh_connect_timeout, command_timeout=s.ssh_command_timeout, cap=s.output_cap_bytes))
    except ssh.SshError as e:
        raise _ssh_http(e) from None


# ───────── эндпоинты (статические пути объявлены раньше /{id}) ─────────
@router.get("/public-key", response_model=PublicKeyOut)
def public_key(ctx: AuthContext = Depends(get_ctx()), db: Session = Depends(get_db)) -> PublicKeyOut:
    existing = _org_key(db, ctx, create=False)
    if existing is None:
        require_role(ctx, "operator")  # создавать ключ может только owner/operator
        existing = _org_key(db, ctx, create=True)
    assert existing is not None
    return PublicKeyOut(key=existing[0])


@router.post("/probe", response_model=ProbeOut)
def probe(body: ProbeIn, request: Request, ctx: AuthContext = Depends(get_ctx()), db: Session = Depends(get_db)) -> ProbeOut:
    require_role(ctx, "operator")
    host, ip = _target(body.host, body.port)
    _guard(ctx)  # лимит считает только реальные исходящие SSH-попытки (после политики адресов)
    s = get_settings()
    try:
        hk = _run(ssh.fetch_host_key(ip, body.port, timeout=s.ssh_connect_timeout))
    except ssh.SshError as e:
        raise _ssh_http(e) from None
    audit.record(db, "server.probe", org_id=ctx.org_id, actor_id=ctx.user.id, target=f"{host}:{body.port}", ip=client_ip(request))
    db.commit()
    return ProbeOut(fingerprint=hk.fingerprint, key_type=hk.algorithm)


@router.get("", response_model=list[ServerOut])
def list_servers(ctx: AuthContext = Depends(get_ctx()), db: Session = Depends(get_db)) -> list[ServerOut]:
    rows = db.scalars(select(Server).where(Server.organization_id == ctx.org_id).order_by(Server.name)).all()
    return [_out(db, r) for r in rows]


@router.post("", response_model=VerifyOut, status_code=201)
def add_server(body: AddServerIn, request: Request, ctx: AuthContext = Depends(get_ctx()), db: Session = Depends(get_db)) -> VerifyOut:
    require_role(ctx, "operator")
    try:
        username = check_username(body.username)
    except HostPolicyError as e:
        raise ApiError(422, e.code, e.message) from None
    host, ip = _target(body.host, body.port)
    _guard(ctx)
    if db.scalar(select(Server.id).where(Server.organization_id == ctx.org_id, Server.host == host,
                                         Server.port == body.port, Server.username == username)):
        raise ApiError(409, "duplicate", "Такой сервер уже добавлен.")
    key = _org_key(db, ctx, create=True)
    assert key is not None
    s = get_settings()
    try:
        hk = _run(ssh.fetch_host_key(ip, body.port, timeout=s.ssh_connect_timeout))
    except ssh.SshError as e:
        raise _ssh_http(e) from None
    # Владелец подтвердил конкретный отпечаток — сервер сейчас должен предъявлять тот же ключ
    if not consteq(hk.fingerprint, body.fingerprint.strip()):
        audit.record(db, "server.fingerprint_mismatch", org_id=ctx.org_id, actor_id=ctx.user.id, target=f"{host}:{body.port}",
                     meta={"expected": body.fingerprint.strip()[:80], "got": hk.fingerprint}, ip=client_ip(request))
        db.commit()
        raise ApiError(409, "host_key_changed", "Отпечаток ключа сервера не совпал с подтверждённым. Подключение заблокировано: возможна подмена сервера.")
    server = Server(organization_id=ctx.org_id, name=(body.name.strip() or host)[:120], host=host, port=body.port,
                    username=username, host_key_openssh=hk.openssh, fingerprint=hk.fingerprint, created_by=ctx.user.id)
    facts = _collect(server, ip, key)  # при ошибке сервер НЕ создаётся
    db.add(server)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise ApiError(409, "duplicate", "Такой сервер уже добавлен.") from None
    _store(db, server, facts, utcnow())
    audit.record(db, "server.add", org_id=ctx.org_id, actor_id=ctx.user.id, target=f"{host}:{body.port}",
                 meta={"fingerprint": hk.fingerprint}, ip=client_ip(request))
    db.commit()
    return VerifyOut(os=facts.os or "—", server=_out(db, server))


@router.get("/{server_id}", response_model=ServerOut)
def get_server(server_id: str, ctx: AuthContext = Depends(get_ctx()), db: Session = Depends(get_db)) -> ServerOut:
    return _out(db, get_server_or_404(db, ctx, server_id))


@router.post("/{server_id}/verify", response_model=ServerOut)
def verify(server_id: str, request: Request, ctx: AuthContext = Depends(get_ctx()), db: Session = Depends(get_db)) -> ServerOut:
    require_role(ctx, "operator")
    server = get_server_or_404(db, ctx, server_id)
    _, ip = _target(server.host, server.port)  # политика применяется при КАЖДОМ подключении (DNS мог измениться)
    _guard(ctx)
    key = _org_key(db, ctx, create=False)
    if key is None:
        raise ApiError(409, "no_key", "Ключ сервиса не создан.")
    now = utcnow()
    try:
        facts = _collect(server, ip, key)
    except ApiError as e:
        server.status, server.last_checked_at, server.last_error_code = "offline", now, e.code
        audit.record(db, "server.check_failed" if e.code != "host_key_changed" else "server.host_key_changed",
                     org_id=ctx.org_id, actor_id=ctx.user.id, target=str(server.id), meta={"code": e.code}, ip=client_ip(request))
        db.commit()
        raise
    _store(db, server, facts, now)
    audit.record(db, "server.verify", org_id=ctx.org_id, actor_id=ctx.user.id, target=str(server.id), ip=client_ip(request))
    db.commit()
    return _out(db, server)


@router.get("/{server_id}/metrics", response_model=MetricsOut)
def metrics(server_id: str, hours: int = Query(24, ge=1, le=168), ctx: AuthContext = Depends(get_ctx()),
            db: Session = Depends(get_db)) -> MetricsOut:
    server = get_server_or_404(db, ctx, server_id)
    since = utcnow() - dt.timedelta(hours=hours)
    rows = db.scalars(select(ServerMetricSample).where(
        ServerMetricSample.server_id == server.id, ServerMetricSample.organization_id == ctx.org_id,
        ServerMetricSample.sampled_at >= since).order_by(ServerMetricSample.sampled_at)).all()
    pts = [
        MetricPoint(t=r.sampled_at, cpu=r.cpu_percent, ram=r.ram_used_mb / r.ram_total_mb * 100, disk=r.disk_used_gb / r.disk_total_gb * 100)
        for r in rows
        if None not in (r.cpu_percent, r.ram_used_mb, r.ram_total_mb, r.disk_used_gb, r.disk_total_gb) and r.ram_total_mb and r.disk_total_gb
    ]
    return MetricsOut(samples=pts, interval_sec=0)


@router.get("/{server_id}/services", response_model=list[ServiceOut])
def services(server_id: str, ctx: AuthContext = Depends(get_ctx()), db: Session = Depends(get_db)) -> list[ServiceOut]:
    return _out(db, get_server_or_404(db, ctx, server_id)).services
