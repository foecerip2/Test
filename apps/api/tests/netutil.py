"""Локальный HTTP-сервер для тестов загрузки сайтов (реального интернета в тестах нет)."""

from __future__ import annotations

import socket
import threading
import time
from collections.abc import Callable, Iterable, Iterator
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any


@dataclass
class Resp:
    status: int = 200
    body: bytes = b""
    content_type: str | None = "text/html; charset=utf-8"
    headers: dict[str, str] = field(default_factory=dict)
    #: Потоковая отдача без Content-Length: куски и пауза между ними.
    chunks: Iterable[bytes] | None = None
    chunk_delay: float = 0.0
    #: Отправить заголовки и «зависнуть» на столько секунд.
    stall: float = 0.0
    declared_length: int | None = None


Route = Resp | Callable[["Request"], Resp]


@dataclass
class Request:
    path: str
    headers: dict[str, str]


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args: Any) -> None:
        pass

    def do_GET(self) -> None:
        server: LocalSite = self.server.site  # type: ignore[attr-defined]
        req = Request(self.path, {k.lower(): v for k, v in self.headers.items()})
        server.log.append(req)
        route = server.routes.get(self.path.split("?", 1)[0]) or server.routes.get("*")
        if route is None:
            self._send(Resp(status=404, body=b"not found"))
            return
        self._send(route(req) if callable(route) else route)

    def _send(self, r: Resp) -> None:
        try:
            self.send_response(r.status)
            if r.content_type is not None:
                self.send_header("Content-Type", r.content_type)
            for k, v in r.headers.items():
                self.send_header(k, v)
            if r.chunks is None:
                length = r.declared_length if r.declared_length is not None else len(r.body)
                self.send_header("Content-Length", str(length))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.flush()
            if r.stall:
                time.sleep(r.stall)
            if r.chunks is not None:
                for chunk in r.chunks:
                    self.wfile.write(chunk)
                    self.wfile.flush()
                    if r.chunk_delay:
                        time.sleep(r.chunk_delay)
            else:
                self.wfile.write(r.body)
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        self.close_connection = True


class LocalSite:
    """Запускается на 127.0.0.1 со свободным портом. Маршруты можно менять на лету."""

    def __init__(self, routes: dict[str, Route] | None = None) -> None:
        self.routes: dict[str, Route] = routes or {}
        self.log: list[Request] = []
        self._server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        self._server.daemon_threads = True
        self._server.site = self  # type: ignore[attr-defined]
        self.port: int = self._server.server_address[1]
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    def __enter__(self) -> LocalSite:
        self._thread.start()
        return self

    def __exit__(self, *exc: object) -> None:
        self._server.shutdown()
        self._server.server_close()

    def paths(self) -> list[str]:
        return [r.path for r in self.log]

    def connector(self) -> Callable[[str, int, float], socket.socket]:
        """Подменяет сокет: любой «проверенный» IP ведёт на локальный сервер; IP запоминается."""
        seen: list[str] = []

        def connect(ip: str, port: int, timeout: float) -> socket.socket:
            seen.append(ip)
            return socket.create_connection(("127.0.0.1", self.port), timeout=timeout)

        connect.seen = seen  # type: ignore[attr-defined]
        return connect


def zeros(total: int, piece: int = 65536) -> Iterator[bytes]:
    sent = 0
    while sent < total:
        n = min(piece, total - sent)
        yield b"a" * n
        sent += n
