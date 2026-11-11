"""Интеграционный тест: PHP-ретранслятор (infra/mail-relay) принимает подпись Python-клиента.

Главная защита от рассинхрона схемы подписи. Пропускается, если нет `php`.
"""

from __future__ import annotations

import shutil
import socket
import subprocess
import threading
import time
from collections.abc import Iterator
from pathlib import Path

import pytest

from app.config import Settings
from app.mail import HttpRelayMailer, MailError

pytestmark = pytest.mark.integration

RELAY_DIR = Path(__file__).resolve().parents[3] / "infra" / "mail-relay"
SECRET = "c" * 48

if shutil.which("php") is None or not (RELAY_DIR / "lh-mail.php").exists():
    pytest.skip("нужны php и infra/mail-relay", allow_module_level=True)


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


class FakeSmtp:
    """Минимальный SMTP без AUTH на stdlib: принимает письмо и запоминает DATA."""

    def __init__(self) -> None:
        self.sock = socket.socket()
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(5)
        self.port = int(self.sock.getsockname()[1])
        self.messages: list[str] = []
        threading.Thread(target=self._serve, daemon=True).start()

    def _serve(self) -> None:
        while True:
            try:
                conn, _ = self.sock.accept()
            except OSError:
                return
            threading.Thread(target=self._handle, args=(conn,), daemon=True).start()

    def _handle(self, conn: socket.socket) -> None:
        f = conn.makefile("rwb", buffering=0)
        f.write(b"220 fake\r\n")
        data_mode, buf = False, []
        while True:
            line = f.readline()
            if not line:
                return
            if data_mode:
                if line == b".\r\n":
                    self.messages.append(b"".join(buf).decode("utf-8", "replace"))
                    data_mode, buf = False, []
                    f.write(b"250 OK\r\n")
                else:
                    buf.append(line)
                continue
            cmd = line[:4].upper()
            if cmd == b"EHLO":
                f.write(b"250-fake\r\n250 8BITMIME\r\n")
            elif cmd == b"DATA":
                data_mode = True
                f.write(b"354 go\r\n")
            elif cmd == b"QUIT":
                f.write(b"221 bye\r\n")
                conn.close()
                return
            else:
                f.write(b"250 OK\r\n")

    def close(self) -> None:
        self.sock.close()


@pytest.fixture
def php_relay(tmp_path: Path) -> Iterator[tuple[str, FakeSmtp, Path]]:
    smtp = FakeSmtp()
    web = tmp_path / "www"
    web.mkdir()
    shutil.copy(RELAY_DIR / "lh-mail.php", web / "lh-mail.php")
    cfg = tmp_path / "lh-mail-config.php"
    cfg.write_text(
        f"""<?php return [
 'secret' => '{SECRET}', 'transport' => 'smtp', 'smtp_host' => '127.0.0.1',
 'smtp_port' => {smtp.port}, 'smtp_security' => 'none', 'smtp_user' => '', 'smtp_password' => '',
 'from' => 'LeadHunter <noreply@vaylonet.test>', 'data_dir' => '{tmp_path / "data"}',
 'allow_insecure_smtp_for_tests' => true, 'allow_insecure_http_for_tests' => true,
];"""
    )
    port = _free_port()
    proc = subprocess.Popen(  # noqa: S603
        ["php", "-S", f"127.0.0.1:{port}", "-t", str(web)],  # noqa: S607
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    for _ in range(100):
        try:
            socket.create_connection(("127.0.0.1", port), 0.2).close()
            break
        except OSError:
            time.sleep(0.05)
    yield f"http://127.0.0.1:{port}/lh-mail.php", smtp, cfg
    proc.terminate()
    proc.wait(5)
    smtp.close()


def _mailer(url: str, secret: str = SECRET) -> HttpRelayMailer:
    return HttpRelayMailer(
        Settings(
            env="dev",
            secret_key="test-secret-key-0123456789-0123456789",
            mail_backend="http",
            mail_relay_url=url,
            mail_relay_secret=secret,
        )
    )


def test_php_accepts_python_signature(php_relay: tuple[str, FakeSmtp, Path]) -> None:
    url, smtp, _ = php_relay
    _mailer(url).send_otp("user@example.com", "987654", 10)
    assert len(smtp.messages) == 1
    assert "Subject: =?UTF-8?B?" in smtp.messages[0]
    assert "To: user@example.com" in smtp.messages[0]


def test_php_rejects_wrong_secret(php_relay: tuple[str, FakeSmtp, Path]) -> None:
    url, smtp, _ = php_relay
    with pytest.raises(MailError, match="401"):
        _mailer(url, secret="x" * 48).send_otp("user@example.com", "987654", 10)
    assert smtp.messages == []


def test_repeated_requests_each_accepted(php_relay: tuple[str, FakeSmtp, Path]) -> None:
    url, smtp, _ = php_relay
    m = _mailer(url)
    for i in range(3):
        m.send_otp(f"u{i}@example.com", "123456", 5)
    assert len(smtp.messages) == 3
