"""Реальное исполнение подтверждённого плана (ADR 0004). Выполняется ТОЛЬКО если одновременно: конфигурация сервера разрешает,
kill switch не нажат, включены выключатели организации и сервера, план подтверждён и не истёк, хеш сходится, сервер онлайн с
закреплённым ключом, политика пройдена заново, операция входит в первую версию исполнителя. Всё это перепроверяется ПЕРЕД КАЖДЫМ
шагом. Первая неудача останавливает исполнение; остальные шаги получают статус skipped. Результат каждого шага фиксируется в БД
сразу (commit), а не в конце. На сервере выполняется только обёртка servermind-op, установленная владельцем."""

from __future__ import annotations

import asyncio
import json
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.security import DecryptionError, decrypt
from app.db.models import ActionPlan, Job, Server, ServerCredential
from app.modules.audit import service as audit
from app.modules.executor import ops
from app.modules.executor.checks import Check, preflight, switch_checks
from app.modules.executor.runner import _finish, _step
from app.modules.servers import ssh
from app.modules.servers.policy import HostPolicyError, resolve_target

_KEY_KIND = "ssh_private_key"


def org_private_key(db: Session, org_id: Any, settings: Settings) -> str:
    """Приватный ключ сервиса организации (хранится только зашифрованным, AEAD с привязкой к организации)."""
    row = db.scalar(select(ServerCredential).where(
        ServerCredential.organization_id == org_id, ServerCredential.kind == _KEY_KIND, ServerCredential.server_id.is_(None)))
    if row is None:
        raise ssh.SshError("no_key", "Ключ сервиса организации не создан.")
    try:
        return decrypt(settings.master_key_bytes, row.ciphertext, f"cred:{org_id}:{_KEY_KIND}".encode()).decode()
    except DecryptionError:
        raise ssh.SshError("crypto", "Не удалось расшифровать ключ сервиса.") from None


def _parse_wrapper(res: ssh.WrapperResult) -> tuple[bool, str]:
    """Ответ обёртки — одна строка JSON. Всё остальное считается неуспехом (не угадываем)."""
    for line in reversed(res.stdout.strip().splitlines()):
        try:
            data = json.loads(line)
        except ValueError:
            continue
        if isinstance(data, dict) and isinstance(data.get("ok"), bool):
            return data["ok"] and res.exit_status == 0, str(data.get("detail", ""))[:500]
    return False, (res.stderr.strip() or res.stdout.strip() or f"нет ответа обёртки (код {res.exit_status})")[:500]


def process_execute(db: Session, job: Job, settings: Settings) -> Job:
    plan = db.get(ActionPlan, job.plan_id)
    if plan is None or plan.organization_id != job.organization_id or plan.revision != job.plan_revision or plan.canonical_hash != job.plan_hash:
        _finish(db, job, "blocked", "План изменился после постановки задания: исполнение отменено, на сервере ничего не выполнено.")
        return job
    steps = [s for s in plan.steps if s.get("enabled", True)]
    done = 0
    stopped = ""
    failed_real = False
    for ord_, step in enumerate(steps, start=1):
        if stopped:
            _step(db, job, ord_, step, "skipped", [], "")
            db.commit()
            continue
        checks: list[Check] = [*preflight(db, plan, settings), *switch_checks(db, settings, plan)]
        bad = [c for c in checks if not c.ok]
        if bad:
            _step(db, job, ord_, step, "blocked", checks, "")
            stopped = bad[0].detail
            db.commit()
            continue
        if step["tool"] not in ops.SUPPORTED:
            _step(db, job, ord_, step, "blocked", [*checks, Check("operation_supported", False, "Эта операция ещё не включена в исполнитель (ADR 0004, п. 4).")], "")
            stopped = f"Операция {step['tool']} ещё не поддерживается исполнителем."
            db.commit()
            continue
        try:
            command = ops.render(step["tool"], step["params"])
            server = db.get(Server, plan.server_id)
            assert server is not None
            _, ip = resolve_target(server.host, server.port)  # политика адресов применяется при КАЖДОМ подключении
            key = org_private_key(db, plan.organization_id, settings)
        except (ops.OpError, HostPolicyError, ssh.SshError) as e:
            msg = getattr(e, "message", None) or str(e)
            _step(db, job, ord_, step, "failed", [*checks, Check("prepare", False, msg[:300])], "")
            stopped, failed_real = msg[:300], False
            db.commit()
            continue
        audit.record(db, "job.step_started", org_id=job.organization_id, target=str(job.plan_id), meta={"tool": step["tool"], "step": ord_})
        db.commit()  # фиксируем намерение ДО отправки команды: после сбоя процесса видно, что шаг мог начаться
        try:
            res = asyncio.run(ssh.run_wrapper(ip, server.port, server.username, key, server.host_key_openssh, command,
                                              connect_timeout=settings.ssh_connect_timeout, command_timeout=90, cap=settings.output_cap_bytes))
        except ssh.SshError as e:
            _step(db, job, ord_, step, "failed", checks, command, output=e.message)
            audit.record(db, "job.step_finished", org_id=job.organization_id, target=str(job.plan_id), meta={"tool": step["tool"], "step": ord_, "status": "failed", "code": e.code})
            stopped, failed_real = e.message[:300], True
            db.commit()
            continue
        ok, detail = _parse_wrapper(res)
        _step(db, job, ord_, step, "executed" if ok else "failed", [*checks, Check("operation_supported", True, "Операция входит в первую версию исполнителя.")], command, output=detail)
        audit.record(db, "job.step_finished", org_id=job.organization_id, target=str(job.plan_id), meta={"tool": step["tool"], "step": ord_, "status": "executed" if ok else "failed"})
        db.commit()
        if ok:
            done += 1
        else:
            stopped, failed_real = f"Шаг {ord_} ({step['tool']}) завершился неуспешно: {detail}"[:300], True
    total = len(steps)
    if not stopped:
        _finish(db, job, "succeeded", f"Исполнено шагов: {done} из {total}.")
    elif done == 0 and not failed_real:
        _finish(db, job, "blocked", f"Исполнение остановлено до отправки команд: {stopped} На сервере ничего не выполнялось.")
    else:
        _finish(db, job, "failed", f"Исполнено шагов: {done} из {total}. Остановлено: {stopped} Откат автоматически не выполняется — проверьте сервер.")
    return job
