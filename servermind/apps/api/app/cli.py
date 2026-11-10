"""Администрирование без веб-регистрации (закрытая бета: пользователей создаёт владелец).

    python -m app.cli create-user --email you@example.com --name "Имя" --org "Моё пространство" --role owner
    python -m app.cli public-key --email you@example.com
    python -m app.cli check-host --email you@example.com --host 203.0.113.10 --username servermind
    python -m app.cli check-host ... --fingerprint SHA256:...      # второй шаг: только чтение, без записи в БД

Пароль читается из getpass или переменной SM_PASSWORD (не передавайте пароль аргументом командной строки).
"""

from __future__ import annotations

import argparse
import asyncio
import getpass
import json
import os
import sys
from dataclasses import asdict

from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.security import consteq, decrypt, encrypt, hash_password
from app.db.models import AiKey, Membership, Organization, ServerCredential, User
from app.db.session import _factory
from app.modules.ai import chatgpt, chatgpt_auth
from app.modules.ai.providers import ProviderError
from app.modules.ai.router import MODEL_RE
from app.modules.audit import service as audit
from app.modules.servers import ssh
from app.modules.servers.policy import HostPolicyError, check_username, resolve_target
from app.modules.servers.router import _KEY_KIND, _aad


def _user_org(db: Session, email: str) -> tuple[User, Membership]:
    user = db.scalar(select(User).where(User.email == email.strip().lower()))
    if user is None:
        sys.exit(f"Пользователь {email} не найден.")
    m = db.scalar(select(Membership).where(Membership.user_id == user.id))
    if m is None:
        sys.exit("У пользователя нет рабочего пространства.")
    return user, m


def _org_key(db: Session, org_id: object, *, create: bool) -> tuple[str, str] | None:
    s = get_settings()
    row = db.scalar(select(ServerCredential).where(
        ServerCredential.organization_id == org_id, ServerCredential.kind == _KEY_KIND, ServerCredential.server_id.is_(None)))
    if row is None:
        if not create:
            return None
        private, public = ssh.generate_service_key(f"servermind-{str(org_id)[:8]}")
        row = ServerCredential(organization_id=org_id, kind=_KEY_KIND, public_key=public,
                               ciphertext=encrypt(s.master_key_bytes, private.encode(), _aad(org_id)))
        db.add(row)
        db.commit()
    return row.public_key, decrypt(s.master_key_bytes, row.ciphertext, _aad(org_id)).decode()


def cmd_create_user(a: argparse.Namespace) -> None:
    password = os.environ.get("SM_PASSWORD") or getpass.getpass("Пароль (≥12 символов): ")
    if len(password) < 12:
        sys.exit("Пароль слишком короткий (нужно не меньше 12 символов).")
    with _factory()() as db:
        if db.scalar(select(User.id).where(User.email == a.email.lower())):
            sys.exit("Такой пользователь уже существует.")
        org = db.get(Organization, a.org_id) if a.org_id else Organization(name=a.org)
        if org is None:
            sys.exit("Организация не найдена.")
        db.add(org)
        db.flush()
        user = User(email=a.email.lower(), name=a.name, password_hash=hash_password(password))
        db.add(user)
        db.flush()
        db.add(Membership(organization_id=org.id, user_id=user.id, role=a.role))
        db.commit()
        print(f"Создан {a.role}: {user.email} (организация {org.id}). При первом входе будет предложено настроить 2FA.")


def cmd_public_key(a: argparse.Namespace) -> None:
    with _factory()() as db:
        _, m = _user_org(db, a.email)
        key = _org_key(db, m.organization_id, create=True)
        assert key is not None
        print(key[0])


def cmd_check_host(a: argparse.Namespace) -> None:
    """Read-only проверка: шаг 1 — показать отпечаток ключа хоста; шаг 2 (--fingerprint) — подключиться и прочитать факты."""
    s = get_settings()
    try:
        username = check_username(a.username, accept_root_risk=a.accept_root_risk)
        host, ip = resolve_target(a.host, a.port)
    except HostPolicyError as e:
        sys.exit(f"Отклонено политикой: {e.message}")
    hk = asyncio.run(ssh.fetch_host_key(ip, a.port, timeout=s.ssh_connect_timeout))
    print(f"Ключ хоста {host}:{a.port}  {hk.algorithm}  {hk.fingerprint}")
    if not a.fingerprint:
        print("Сверьте отпечаток с сервером (ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub) и повторите с --fingerprint.")
        return
    if not consteq(hk.fingerprint, a.fingerprint.strip()):
        sys.exit("ОТПЕЧАТОК НЕ СОВПАЛ — подключение заблокировано (возможна подмена сервера).")
    with _factory()() as db:
        _, m = _user_org(db, a.email)
        key = _org_key(db, m.organization_id, create=False)
    if key is None:
        sys.exit("Ключ сервиса ещё не создан: выполните `public-key` и добавьте его на сервер.")
    try:
        facts = asyncio.run(ssh.collect_facts(ip, a.port, username, key[1], hk.openssh, connect_timeout=s.ssh_connect_timeout,
                                              command_timeout=s.ssh_command_timeout, cap=s.output_cap_bytes))
    except ssh.SshError as e:
        sys.exit(f"[{e.code}] {e.message}")
    print(json.dumps(asdict(facts), ensure_ascii=False, indent=2))


def cmd_chatgpt_import(a: argparse.Namespace) -> None:
    if sys.stdin.isatty():
        sys.exit("Передайте защищённый файл сессии через stdin по SSH.")
    if not MODEL_RE.fullmatch(a.model):
        sys.exit("Некорректное имя модели.")
    try:
        session = chatgpt_auth.ChatGPTSession.model_validate_json(sys.stdin.buffer.read(64 * 1024))
        if a.model not in chatgpt_auth.listed_models(session.access_token, 15):
            sys.exit("Эта модель недоступна в выбранном аккаунте ChatGPT.")
    except ValidationError:
        sys.exit("Неверный файл сессии ServerMind.")
    except ProviderError as error:
        sys.exit(error.message)

    with _factory()() as db:
        user, member = _user_org(db, a.email)
        if member.role != "owner" or not user.is_active:
            sys.exit("Подключение подписки доступно только активному владельцу.")
        org_id = member.organization_id
        db.execute(select(Organization.id).where(Organization.id == org_id).with_for_update()).scalar_one()
        previous = db.scalar(select(AiKey).where(AiKey.organization_id == org_id, AiKey.provider == chatgpt.PROVIDER).with_for_update())
        if previous is not None:
            if previous.created_by is not None and previous.created_by != user.id:
                sys.exit("Подписку уже подключил другой владелец пространства.")
            db.delete(previous)
            db.flush()
        label = "ChatGPT"
        if "@" in session.email:
            local, _, domain = session.email.partition("@")
            label = f"{local[:2]}•••@{domain}"[:32]
        db.add(AiKey(organization_id=org_id, created_by=user.id, provider=chatgpt.PROVIDER, model=a.model,
                     status="valid", masked=label, key_enc=chatgpt.encode(session, org_id)))
        audit.record(db, "ai_account.connect", org_id=org_id, actor_id=user.id, target=chatgpt.PROVIDER, meta={"model": a.model})
        db.commit()
    print("Подписка ChatGPT подключена. Проверьте статус в «Админка → Подключение AI».")


def main() -> None:
    p = argparse.ArgumentParser(prog="app.cli")
    sub = p.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("create-user")
    c.add_argument("--email", required=True)
    c.add_argument("--name", default="")
    c.add_argument("--org", default="Личное пространство")
    c.add_argument("--org-id", default=None)
    c.add_argument("--role", choices=["owner", "operator", "viewer"], default="owner")
    c.set_defaults(fn=cmd_create_user)
    k = sub.add_parser("public-key")
    k.add_argument("--email", required=True)
    k.set_defaults(fn=cmd_public_key)
    h = sub.add_parser("check-host")
    h.add_argument("--email", required=True)
    h.add_argument("--host", required=True)
    h.add_argument("--port", type=int, default=22)
    h.add_argument("--accept-root-risk", action="store_true", help="разрешить вход под root (ключ ServerMind получит полный доступ)")
    h.add_argument("--username", default="servermind")
    h.add_argument("--fingerprint", default=None)
    h.set_defaults(fn=cmd_check_host)
    g = sub.add_parser("chatgpt-import", help="импортировать сессию Sign in with ChatGPT из stdin")
    g.add_argument("--email", required=True)
    g.add_argument("--model", required=True)
    g.set_defaults(fn=cmd_chatgpt_import)
    a = p.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
