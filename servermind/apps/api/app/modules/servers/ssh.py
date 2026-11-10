"""SSH-слой (только чтение). Принципы:
- команды — ТОЛЬКО константы из ALLOWED_COMMANDS; пользовательский ввод в команды не подставляется;
- подключение по уже проверенному IP, ключ хоста закреплён (known_hosts=[pinned]), StrictHostKeyChecking не отключается;
- вход только по ключу (пароли/keyboard-interactive/agent/~/.ssh/config отключены);
- вывод ограничен по размеру и очищается от секретов до логов/ответов;
- отсутствующие данные = None, а не выдуманные значения.
"""

from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass, field

import asyncssh

from app.core.security import redact

SERVICE_UNITS = ("ssh", "sshd", "nginx", "docker", "caddy", "postgresql")

ALLOWED_COMMANDS: dict[str, str] = {
    "os_release": "cat /etc/os-release",
    "uptime": "cat /proc/uptime",
    "cpu": "head -n 1 /proc/stat; sleep 1; head -n 1 /proc/stat",
    "meminfo": "cat /proc/meminfo",
    "disk": "df -P -B1 /",
    "unit_files": "systemctl list-unit-files --type=service --no-legend --no-pager",
    "is_active": "systemctl is-active " + " ".join(SERVICE_UNITS),
}


class SshError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class HostKeyInfo:
    algorithm: str
    fingerprint: str  # SHA256:...
    openssh: str      # "ssh-ed25519 AAAA..."


@dataclass
class Facts:
    os: str | None = None
    uptime_seconds: int | None = None
    cpu_percent: float | None = None
    ram_used_mb: int | None = None
    ram_total_mb: int | None = None
    disk_used_gb: float | None = None
    disk_total_gb: float | None = None
    services: list[tuple[str, str]] = field(default_factory=list)


# ───────── разбор вывода (чистые функции) ─────────
def parse_os_release(text: str) -> str | None:
    m = re.search(r'^PRETTY_NAME="?([^"\n]+)"?$', text, re.M)
    return m.group(1).strip()[:120] if m else None


def parse_uptime(text: str) -> int | None:
    m = re.match(r"\s*(\d+(?:\.\d+)?)\s", text + " ")
    return int(float(m.group(1))) if m else None


def parse_cpu(text: str) -> float | None:
    lines = [ln for ln in text.splitlines() if ln.startswith("cpu ")]
    if len(lines) < 2:
        return None
    try:
        a = [int(x) for x in lines[0].split()[1:]]
        b = [int(x) for x in lines[1].split()[1:]]
    except ValueError:
        return None
    if len(a) < 5 or len(b) < 5:
        return None
    idle = (b[3] + b[4]) - (a[3] + a[4])  # idle + iowait
    total = sum(b) - sum(a)
    if total <= 0:
        return None
    return round(max(0.0, min(100.0, (total - idle) / total * 100)), 1)


def parse_meminfo(text: str) -> tuple[int | None, int | None]:
    def kb(name: str) -> int | None:
        m = re.search(rf"^{name}:\s+(\d+)\s*kB", text, re.M)
        return int(m.group(1)) if m else None

    total, avail = kb("MemTotal"), kb("MemAvailable")
    if total is None or avail is None:
        return None, None
    return round((total - avail) / 1024), round(total / 1024)


def parse_df(text: str) -> tuple[float | None, float | None]:
    lines = [ln for ln in text.strip().splitlines() if ln.strip()]
    if len(lines) < 2:
        return None, None
    parts = lines[-1].split()
    try:
        total, used = int(parts[1]), int(parts[2])
    except (IndexError, ValueError):
        return None, None
    gb = 1024**3
    return round(used / gb, 1), round(total / gb, 1)


def parse_services(unit_files: str, is_active: str) -> list[tuple[str, str]]:
    installed = {ln.split()[0].removesuffix(".service") for ln in unit_files.splitlines() if ln.strip()}
    states = [ln.strip() for ln in is_active.splitlines() if ln.strip()]
    out: list[tuple[str, str]] = []
    for unit, state in zip(SERVICE_UNITS, states, strict=False):
        if unit in installed:
            out.append((unit, state if state in ("active", "failed", "inactive") else "unknown"))
    return out


def fingerprint_of(key: asyncssh.SSHKey) -> str:
    return key.get_fingerprint("sha256")


def _info(key: asyncssh.SSHKey) -> HostKeyInfo:
    return HostKeyInfo(
        algorithm=key.algorithm.decode() if isinstance(key.algorithm, bytes) else str(key.algorithm),
        fingerprint=fingerprint_of(key),
        openssh=key.export_public_key("openssh").decode().strip(),
    )


# ───────── сетевые операции ─────────
async def fetch_host_key(ip: str, port: int, *, timeout: int) -> HostKeyInfo:
    """Получает публичный ключ хоста БЕЗ аутентификации (для сверки отпечатка владельцем)."""
    try:
        key = await asyncio.wait_for(
            asyncssh.get_server_host_key(ip, port, server_host_key_algs=["ssh-ed25519", "rsa-sha2-512", "rsa-sha2-256", "ecdsa-sha2-nistp256"], config=[]),
            timeout=timeout,
        )
    except TimeoutError:
        raise SshError("timeout", f"Таймаут соединения ({timeout} с). Сервер не отвечает или порт закрыт.") from None
    except ConnectionRefusedError:
        raise SshError("unreachable", f"Соединение с {ip}:{port} отклонено. Проверьте порт и firewall.") from None
    except (OSError, asyncssh.Error) as e:
        raise SshError("unreachable", f"Не удалось подключиться: {redact(str(e))[:200]}") from None
    if key is None:
        raise SshError("unreachable", "Сервер не предоставил ключ хоста.")
    return _info(key)


async def _run(conn: asyncssh.SSHClientConnection, name: str, *, timeout: int, cap: int) -> str:
    cmd = ALLOWED_COMMANDS[name]  # KeyError = программная ошибка: произвольные команды невозможны
    try:
        res = await asyncio.wait_for(conn.run(cmd, check=False, input=None), timeout=timeout)
    except TimeoutError:
        raise SshError("timeout", f"Команда «{name}» не завершилась за {timeout} с.") from None
    out = res.stdout if isinstance(res.stdout, str) else (res.stdout or b"").decode(errors="replace")
    return redact(out[:cap])


async def collect_facts(
    ip: str, port: int, username: str, private_key_pem: str, pinned_host_key_openssh: str,
    *, connect_timeout: int, command_timeout: int, cap: int,
) -> Facts:
    """Подключение с закреплённым ключом хоста и сбор read-only фактов фиксированным набором команд."""
    pinned = asyncssh.import_public_key(pinned_host_key_openssh)
    client_key = asyncssh.import_private_key(private_key_pem)
    try:
        conn = await asyncio.wait_for(
            asyncssh.connect(
                ip, port, username=username, client_keys=[client_key], known_hosts=([pinned], [], []),
                password=None, passphrase=None, agent_path=None, config=[],
                password_auth=False, kbdint_auth=False, public_key_auth=True,
                connect_timeout=connect_timeout, login_timeout=connect_timeout,
            ),
            timeout=connect_timeout + 5,
        )
    except asyncssh.HostKeyNotVerifiable:
        raise SshError("host_key_changed", "Ключ сервера не совпал с подтверждённым. Подключение заблокировано: возможна подмена сервера.") from None
    except asyncssh.PermissionDenied:
        raise SshError("auth_failed", f"Сервер отклонил ключ ServerMind. Добавьте публичный ключ в ~/.ssh/authorized_keys пользователя «{username}».") from None
    except TimeoutError:
        raise SshError("timeout", f"Таймаут соединения ({connect_timeout} с).") from None
    except ConnectionRefusedError:
        raise SshError("unreachable", f"Соединение с {ip}:{port} отклонено.") from None
    except (OSError, asyncssh.Error) as e:
        raise SshError("unreachable", f"Не удалось подключиться: {redact(str(e))[:200]}") from None

    async with conn:
        r = {n: await _run(conn, n, timeout=command_timeout, cap=cap) for n in ALLOWED_COMMANDS}
    used_mb, total_mb = parse_meminfo(r["meminfo"])
    d_used, d_total = parse_df(r["disk"])
    return Facts(
        os=parse_os_release(r["os_release"]), uptime_seconds=parse_uptime(r["uptime"]), cpu_percent=parse_cpu(r["cpu"]),
        ram_used_mb=used_mb, ram_total_mb=total_mb, disk_used_gb=d_used, disk_total_gb=d_total,
        services=parse_services(r["unit_files"], r["is_active"]),
    )


def generate_service_key(comment: str) -> tuple[str, str]:
    """(приватный ключ в OpenSSH-формате, публичный ключ с комментарием). Приватный нужно сразу зашифровать AEAD."""
    key = asyncssh.generate_private_key("ssh-ed25519")
    private = key.export_private_key("openssh").decode()
    public = key.export_public_key("openssh").decode().strip() + f" {comment}"
    return private, public
