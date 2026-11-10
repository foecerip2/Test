import json
import sys

import pytest
from sqlalchemy import text

from app import cli


def run(monkeypatch, *argv):
    monkeypatch.setattr(sys, "argv", ["app.cli", *argv])
    cli.main()


def test_create_user_then_full_readonly_check_host(monkeypatch, capsys, db, sshd):
    monkeypatch.setenv("SM_PASSWORD", "a-long-enough-password")
    run(monkeypatch, "create-user", "--email", "CLI@example.com", "--name", "Cli", "--role", "owner")
    assert db.execute(text("SELECT email FROM users")).scalar() == "cli@example.com"
    assert "a-long-enough-password" not in capsys.readouterr().out

    run(monkeypatch, "public-key", "--email", "cli@example.com")
    pub = capsys.readouterr().out.strip()
    assert pub.startswith("ssh-ed25519 ")
    sshd.authorize(pub)

    # шаг 1: только отпечаток, подключения с аутентификацией нет
    run(monkeypatch, "check-host", "--email", "cli@example.com", "--host", "127.0.0.1", "--port", str(sshd.port))
    assert sshd.fingerprint in capsys.readouterr().out
    assert sshd.commands == []

    # шаг 2: подтверждённый отпечаток → чтение фактов
    run(monkeypatch, "check-host", "--email", "cli@example.com", "--host", "127.0.0.1", "--port", str(sshd.port),
        "--fingerprint", sshd.fingerprint)
    out = capsys.readouterr().out
    facts = json.loads(out[out.index("{"):])
    assert facts["os"] == "Ubuntu 24.04.1 LTS" and facts["cpu_percent"] == 50.0
    assert db.execute(text("SELECT count(*) FROM servers")).scalar() == 0  # CLI ничего не пишет в БД серверов


def test_check_host_refuses_wrong_fingerprint(monkeypatch, db, sshd):
    monkeypatch.setenv("SM_PASSWORD", "a-long-enough-password")
    run(monkeypatch, "create-user", "--email", "cli@example.com")
    run(monkeypatch, "public-key", "--email", "cli@example.com")
    with pytest.raises(SystemExit) as e:
        run(monkeypatch, "check-host", "--email", "cli@example.com", "--host", "127.0.0.1", "--port", str(sshd.port),
            "--fingerprint", "SHA256:" + "A" * 43)
    assert "НЕ СОВПАЛ" in str(e.value)
    assert sshd.commands == []


def test_short_password_rejected(monkeypatch):
    monkeypatch.setenv("SM_PASSWORD", "short")
    with pytest.raises(SystemExit):
        run(monkeypatch, "create-user", "--email", "x@example.com")


def test_ledger_verify_reports_ok_and_detects_a_tampered_wallet(monkeypatch, capsys, db, owner):
    from app.modules.billing import ledger  # noqa: PLC0415

    ledger.issue(db, owner.org_id, 500, key="cli-seed-0123456789", actor_id=None, note="seed")
    db.commit()
    run(monkeypatch, "ledger-verify")
    assert "расхождений нет" in capsys.readouterr().out
    db.execute(text("UPDATE wallets SET balance = 900"))  # кэш больше не равен сумме проводок
    db.commit()
    with pytest.raises(SystemExit) as e:
        run(monkeypatch, "ledger-verify")
    assert e.value.code == 1 and "balance 900" in capsys.readouterr().out
    with pytest.raises(SystemExit):
        run(monkeypatch, "ledger-verify", "--org-id", str(owner.org_id))
