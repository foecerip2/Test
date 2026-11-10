"""Обёртка servermind-op, которую владелец ставит на целевой сервер (ADR 0004, вариант A): белый список, строгая проверка,
никакой оболочки. Модуль загружается из bootstrap/target/servermind-op без запуска настоящих systemctl/сети."""

from __future__ import annotations

import http.server
import importlib.machinery
import importlib.util
import json
import pathlib
import threading
from types import SimpleNamespace

import pytest

PATH = pathlib.Path(__file__).resolve().parents[3] / "bootstrap" / "target" / "servermind-op"


def _load():
    loader = importlib.machinery.SourceFileLoader("servermind_op", str(PATH))
    spec = importlib.util.spec_from_loader("servermind_op", loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


op = _load()


class FakeRun:
    """Подменяет subprocess.run: записывает вызовы, отдаёт заготовленные ответы. Любой вызов с shell=True = провал теста."""

    def __init__(self, active_after: int = 1, restart_rc: int = 0, cat_rc: int = 0) -> None:
        self.calls: list[list[str]] = []
        self.active_after, self.restart_rc, self.cat_rc = active_after, restart_rc, cat_rc
        self.checks = 0

    def __call__(self, argv, **kw):
        assert isinstance(argv, list) and kw.get("shell") is False, "обёртка обязана вызывать команды без оболочки"
        self.calls.append(argv)
        if argv[:2] == ["systemctl", "cat"]:
            return SimpleNamespace(returncode=self.cat_rc, stdout="", stderr="")
        if argv[:2] == ["systemctl", "restart"]:
            return SimpleNamespace(returncode=self.restart_rc, stdout="", stderr="")
        if argv[:2] == ["systemctl", "is-active"]:
            self.checks += 1
            return SimpleNamespace(returncode=0, stdout="active\n" if self.checks >= self.active_after else "activating\n", stderr="")
        raise AssertionError(f"неожиданная команда {argv}")


@pytest.fixture
def allow(tmp_path):
    f = tmp_path / "managed-services"
    f.write_text("# службы, которые ServerMind может перезапускать\nnginx\ncaddy.service  # комментарий\n")
    return str(f)


def run_main(args, capsys, **deps):
    rc = op.main(["servermind-op", *args], require_root=False, **deps)
    out = capsys.readouterr().out.strip()
    return rc, json.loads(out) if out.startswith("{") else out


# ───────── отказы ─────────
@pytest.mark.parametrize("args", [[], ["service.restart"], ["rm", "{}"], ["service.restart", "{}", "extra"], ["shell", '{"cmd":"id"}'],
                                  ["service.restart", "not json"], ["service.restart", "[1]"], ["service.restart", "x" * 2100]])
def test_malformed_calls_are_refused(args, capsys, allow):
    rc, res = run_main(args, capsys, run=FakeRun(), allowlist=allow)
    assert rc == 2 and res["ok"] is False and res["detail"].startswith("отказ")


@pytest.mark.parametrize("unit", ["nginx; rm -rf /", "nginx && id", "$(id)", "`id`", "../etc", "ngi nx", "NGINX", "nginx\nssh", "", "-h", "a" * 70])
def test_injection_attempts_in_unit_never_reach_a_command(unit, capsys, allow):
    fake = FakeRun()
    rc, res = run_main(["service.restart", json.dumps({"unit": unit})], capsys, run=fake, allowlist=allow)
    assert rc == 2 and res["ok"] is False and fake.calls == []


def test_extra_and_missing_fields_are_refused(capsys, allow):
    fake = FakeRun()
    assert run_main(["service.restart", '{"unit":"nginx","x":1}'], capsys, run=fake, allowlist=allow)[0] == 2
    assert run_main(["service.restart", "{}"], capsys, run=fake, allowlist=allow)[0] == 2
    assert fake.calls == []


def test_service_outside_the_owner_allowlist_is_refused(capsys, allow):
    fake = FakeRun()
    rc, res = run_main(["service.restart", '{"unit":"sshd"}'], capsys, run=fake, allowlist=allow)
    assert rc == 2 and "белый список" in res["detail"] and fake.calls == []


def test_missing_allowlist_means_deny_everything(capsys, tmp_path):
    rc, res = run_main(["service.restart", '{"unit":"nginx"}'], capsys, run=FakeRun(), allowlist=str(tmp_path / "nope"))
    assert rc == 2 and "белый список служб не найден" in res["detail"]


def test_unknown_unit_on_server_is_refused(capsys, allow):
    rc, res = run_main(["service.restart", '{"unit":"nginx"}'], capsys, run=FakeRun(cat_rc=1), allowlist=allow)
    assert rc == 2 and "не найдена" in res["detail"]


def test_non_root_is_refused_by_default(capsys, monkeypatch):
    monkeypatch.setattr(op.os, "geteuid", lambda: 1000)
    assert op.main(["servermind-op", "service.restart", '{"unit":"nginx"}']) == 2
    assert "sudo" in json.loads(capsys.readouterr().out)["detail"]


# ───────── успешные операции ─────────
def test_restart_runs_exactly_three_fixed_commands_without_a_shell(capsys, allow):
    fake = FakeRun(active_after=3)
    rc, res = run_main(["service.restart", '{"unit":"nginx"}'], capsys, run=fake, allowlist=allow, sleep=lambda s: None)
    assert rc == 0 and res == {"ok": True, "op": "service.restart", "detail": "nginx.service: active"}
    assert fake.calls[0] == ["systemctl", "cat", "nginx.service"] and fake.calls[1] == ["systemctl", "restart", "nginx.service"]
    assert all(c[0] == "systemctl" for c in fake.calls)


def test_restart_reports_failure_honestly(capsys, allow):
    rc, res = run_main(["service.restart", '{"unit":"nginx"}'], capsys, run=FakeRun(restart_rc=1), allowlist=allow, sleep=lambda s: None)
    assert rc == 1 and res["ok"] is False
    rc, res = run_main(["service.restart", '{"unit":"caddy"}'], capsys, run=FakeRun(active_after=99), allowlist=allow, sleep=lambda s: None)
    assert rc == 1 and res["ok"] is False and "не стала active" in res["detail"]


def test_service_suffix_in_allowlist_and_param_are_equivalent(capsys, allow):
    fake = FakeRun()
    rc, res = run_main(["service.restart", '{"unit":"caddy.service"}'], capsys, run=fake, allowlist=allow, sleep=lambda s: None)
    assert rc == 0 and fake.calls[1] == ["systemctl", "restart", "caddy.service"]


# ───────── http.healthcheck ─────────
class _H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        if self.path == "/redirect":
            self.send_response(302)
            self.send_header("Location", "http://169.254.169.254/")
            self.end_headers()
            return
        self.send_response(200 if self.path == "/ok" else 503)
        self.end_headers()

    def log_message(self, *a):
        pass


@pytest.fixture
def local_http():
    srv = http.server.HTTPServer(("127.0.0.1", 0), _H)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    yield srv.server_address[1]
    srv.shutdown()


def test_healthcheck_checks_status_and_does_not_follow_redirects(capsys, local_http):
    base = f"http://127.0.0.1:{local_http}"
    assert run_main(["http.healthcheck", json.dumps({"url": base + "/ok"})], capsys)[1]["ok"] is True
    assert run_main(["http.healthcheck", json.dumps({"url": base + "/bad"})], capsys)[1]["ok"] is False
    assert run_main(["http.healthcheck", json.dumps({"url": base + "/bad", "expect_status": 503})], capsys)[1]["ok"] is True
    rc, res = run_main(["http.healthcheck", json.dumps({"url": base + "/redirect", "expect_status": 200})], capsys)
    assert res["ok"] is False and "302" in res["detail"]  # редирект на metadata-адрес НЕ выполнен


@pytest.mark.parametrize("url", ["http://10.0.0.1:80/", "http://127.0.0.1.evil.com:80/", "https://127.0.0.1:443/", "http://localhost:80/",
                                 "http://127.0.0.1:80/x?y=1", "http://127.0.0.1/", "http://[::1]:80/", "file:///etc/passwd", "http://127.0.0.1:80/a b"])
def test_healthcheck_only_talks_to_localhost(url, capsys):
    rc, res = run_main(["http.healthcheck", json.dumps({"url": url})], capsys)
    assert rc == 2 and res["ok"] is False


def test_healthcheck_param_ranges(capsys):
    for bad in ({"url": "http://127.0.0.1:80/", "expect_status": 99}, {"url": "http://127.0.0.1:80/", "timeout_s": 31},
                {"url": "http://127.0.0.1:80/", "timeout_s": True}, {"url": "http://127.0.0.1:80/", "other": 1}):
        assert run_main(["http.healthcheck", json.dumps(bad)], capsys)[0] == 2


def test_version_and_catalog_parity(capsys):
    assert op.main(["servermind-op", "--version"]) == 0 and "servermind-op" in capsys.readouterr().out
    from app.modules.policy import catalog  # noqa: PLC0415
    assert set(op.OPS) <= set(catalog.CATALOG)  # обёртка не знает операций вне каталога
    assert op.UNIT_RE.pattern == catalog.UNIT_RE.pattern and op.URL_RE.pattern == catalog.LOCAL_URL_RE.pattern  # те же регулярные выражения


def test_documented_hash_matches_the_script():
    """Владелец сверяет sha256 из руководства с тем, что скачал: документ не должен отставать от скрипта."""
    import hashlib  # noqa: PLC0415
    doc = (PATH.parents[2] / "docs" / "operations" / "target-wrapper.md").read_text(encoding="utf-8")
    assert hashlib.sha256(PATH.read_bytes()).hexdigest() in doc
