"""Тестовый SSH-сервер (asyncssh) на 127.0.0.1 в отдельном потоке. Настоящий протокол SSH: проверка ключа хоста и
аутентификации по ключу тестируется всерьёз. Ответы на команды — ЗАГОТОВЛЕННЫЕ тестовые данные, не реальный сервер."""

from __future__ import annotations

import asyncio
import threading

import asyncssh

from app.modules.servers.ssh import ALLOWED_COMMANDS

RESPONSES: dict[str, str] = {
    ALLOWED_COMMANDS["os_release"]: 'NAME="Ubuntu"\nPRETTY_NAME="Ubuntu 24.04.1 LTS"\nVERSION_ID="24.04"\n',
    ALLOWED_COMMANDS["uptime"]: "1566000.12 3000000.10\n",
    # Δuser=50, Δsystem=50, Δidle=100 → загрузка CPU ровно 50%
    ALLOWED_COMMANDS["cpu"]: "cpu  100 0 100 800 0 0 0 0 0 0\ncpu  150 0 150 900 0 0 0 0 0 0\n",
    ALLOWED_COMMANDS["meminfo"]: "MemTotal:        4194304 kB\nMemFree:          524288 kB\nMemAvailable:    2097152 kB\n",
    ALLOWED_COMMANDS["disk"]: (
        "Filesystem     1-blocks        Used   Available Capacity Mounted on\n"
        "/dev/vda1   42949672960 12884901888 30064771072      30% /\n"
    ),
    ALLOWED_COMMANDS["unit_files"]: "ssh.service enabled enabled\nnginx.service enabled enabled\ndocker.service enabled enabled\ncron.service enabled enabled\n",
    ALLOWED_COMMANDS["is_active"]: "active\ninactive\nactive\nfailed\ninactive\ninactive\n",
}


class _Server(asyncssh.SSHServer):
    def __init__(self, owner: FakeSshd) -> None:
        self.owner = owner

    def begin_auth(self, username: str) -> bool:
        return True

    def public_key_auth_supported(self) -> bool:
        return True

    def password_auth_supported(self) -> bool:
        return False

    def validate_public_key(self, username: str, key: asyncssh.SSHKey) -> bool:
        return any(key.public_data == k.public_data for k in self.owner.authorized)


class FakeSshd:
    def __init__(self) -> None:
        self.commands: list[str] = []
        self.authorized: list[asyncssh.SSHKey] = []
        self.port = 0
        self.fingerprint = ""
        self._loop: asyncio.AbstractEventLoop | None = None
        self._server: asyncssh.SSHAcceptor | None = None
        self._thread: threading.Thread | None = None

    def authorize(self, openssh_public_key: str) -> None:
        self.authorized.append(asyncssh.import_public_key(openssh_public_key))

    async def _handle(self, process: asyncssh.SSHServerProcess) -> None:
        cmd = process.command or ""
        self.commands.append(cmd)
        out = RESPONSES.get(cmd)
        if out is None:
            process.stderr.write("command not allowed\n")
            process.exit(127)
        else:
            process.stdout.write(out)
            process.exit(0)

    async def _start(self, port: int, key: asyncssh.SSHKey) -> None:
        self.fingerprint = key.get_fingerprint("sha256")
        self._server = await asyncssh.create_server(
            lambda: _Server(self), "127.0.0.1", port, server_host_keys=[key], process_factory=self._handle, reuse_address=True)
        self.port = self._server.sockets[0].getsockname()[1]

    def start(self, port: int = 0) -> FakeSshd:
        ready = threading.Event()
        key = asyncssh.generate_private_key("ssh-ed25519")

        def run() -> None:
            self._loop = asyncio.new_event_loop()
            asyncio.set_event_loop(self._loop)
            self._loop.run_until_complete(self._start(port, key))
            ready.set()
            self._loop.run_forever()

        self._thread = threading.Thread(target=run, daemon=True)
        self._thread.start()
        assert ready.wait(10), "fake sshd не запустился"
        return self

    def stop(self) -> None:
        if self._loop is None or self._thread is None:
            return
        loop = self._loop

        async def close() -> None:
            assert self._server is not None
            self._server.close()
            await self._server.wait_closed()

        asyncio.run_coroutine_threadsafe(close(), loop).result(10)
        loop.call_soon_threadsafe(loop.stop)
        self._thread.join(10)
        self._loop = self._thread = None

    def restart_with_new_host_key(self) -> None:
        """Тот же порт, другой ключ хоста — имитация подмены сервера."""
        port = self.port
        self.stop()
        self.start(port)
