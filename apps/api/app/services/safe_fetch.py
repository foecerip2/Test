"""Безопасная загрузка внешних страниц (SSRF).

Что делает этот модуль, и только он ходит в сеть за чужими сайтами:

* принимает только http/https, порты 80/443, без учётных данных в URL, имя хоста — IDNA;
* сам резолвит DNS и проверяет КАЖДЫЙ адрес (A и AAAA); если запрещён хотя бы один — отказ;
* соединяется с уже проверенным IP (pinning), `Host`/SNI остаются исходными (DNS rebinding);
* редиректы выполняет вручную (не более 3), каждый шаг заново проходит все проверки;
* лимиты: connect 10 с, чтение 20 с, общий дедлайн 30 с, 1 МБ ПОСЛЕ распаковки (gzip-бомбы);
* только text/html и application/xhtml+xml (robots.txt — text/plain); cookie не принимаются;
* robots.txt (кэш на сутки), троттлинг 1 запрос в 2 с на домен, не более 5 страниц на домен.

Реализация на stdlib (`socket`, `ssl`, `http.client`, `zlib`): минимальный вес и полный контроль
над соединением. JavaScript не исполняется.
"""

from __future__ import annotations

import contextlib
import http.client
import ipaddress
import logging
import re
import socket
import ssl
import threading
import time
import zlib
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from typing import Final
from urllib.parse import quote, urljoin, urlsplit

log = logging.getLogger("leadhunter.fetch")

USER_AGENT: Final = "LeadHunterBot/1.0 (+https://ai.vaylonet.ru)"
ROBOTS_TOKEN: Final = "leadhunterbot"  # noqa: S105
ALLOWED_PORTS: Final = frozenset({80, 443})
HTML_TYPES: Final = frozenset({"text/html", "application/xhtml+xml"})
ROBOTS_TYPES: Final = frozenset({"text/plain"})
REDIRECT_STATUSES: Final = frozenset({301, 302, 303, 307, 308})
MAX_URL_LENGTH: Final = 2000
MAX_PAGES_PER_DOMAIN: Final = 5
THROTTLE_SECONDS: Final = 2.0
ROBOTS_TTL_SECONDS: Final = 24 * 3600


@dataclass(frozen=True)
class FetchLimits:
    connect_timeout: float = 10.0
    read_timeout: float = 20.0
    total_deadline: float = 30.0
    max_body_bytes: int = 1024 * 1024
    max_redirects: int = 3


class FetchError(Exception):
    """Ошибка загрузки. `code` — стабильный машинный код; `message` — без адресов и секретов."""

    def __init__(self, code: str, message: str, *, retryable: bool = False) -> None:
        super().__init__(code)
        self.code = code
        self.message = message
        self.retryable = retryable


# ---------------------------------------------------------------------------------------------
# Адреса: что считается «внутренним».

_BLOCKED_V4 = tuple(
    ipaddress.ip_network(n)
    for n in (
        "0.0.0.0/8",  # «эта сеть», unspecified
        "10.0.0.0/8",  # RFC1918
        "100.64.0.0/10",  # CGNAT
        "127.0.0.0/8",  # loopback
        "169.254.0.0/16",  # link-local, в т.ч. метаданные облака 169.254.169.254
        "172.16.0.0/12",  # RFC1918
        "192.0.0.0/24",  # IETF protocol assignments
        "192.0.2.0/24",  # документация TEST-NET-1
        "192.88.99.0/24",  # 6to4 relay (устар.)
        "192.168.0.0/16",  # RFC1918
        "198.18.0.0/15",  # бенчмарки
        "198.51.100.0/24",  # документация TEST-NET-2
        "203.0.113.0/24",  # документация TEST-NET-3
        "224.0.0.0/4",  # multicast
        "240.0.0.0/4",  # reserved + broadcast
    )
)
_BLOCKED_V6 = tuple(
    ipaddress.ip_network(n)
    for n in (
        "::/96",  # unspecified, loopback, IPv4-compatible (устар.)
        "64:ff9b::/96",  # NAT64
        "64:ff9b:1::/48",  # NAT64 локальный
        "100::/64",  # discard-only
        "2001::/32",  # Teredo
        "2001:2::/48",  # бенчмарки
        "2001:10::/28",  # ORCHID
        "2001:db8::/32",  # документация
        "2002::/16",  # 6to4
        "3fff::/20",  # документация (RFC 9637)
        "fc00::/7",  # ULA
        "fe80::/10",  # link-local
        "fec0::/10",  # site-local (устар.)
        "ff00::/8",  # multicast
    )
)

IPAddress = ipaddress.IPv4Address | ipaddress.IPv6Address


def ip_is_blocked(addr: IPAddress) -> bool:
    """True, если адрес нельзя использовать для загрузки (внутренний, служебный, не глобальный)."""
    if isinstance(addr, ipaddress.IPv6Address):
        mapped = addr.ipv4_mapped
        if mapped is not None:  # ::ffff:a.b.c.d — решает вложенный IPv4
            return ip_is_blocked(mapped)
        if any(addr in net for net in _BLOCKED_V6):
            return True
    elif any(addr in net for net in _BLOCKED_V4):
        return True
    return not addr.is_global


def ip_string_is_blocked(value: str) -> bool:
    try:
        addr = ipaddress.ip_address(value.split("%", 1)[0])
    except ValueError:
        return True  # непонятное — запрещено
    return ip_is_blocked(addr)


# ---------------------------------------------------------------------------------------------
# URL.


@dataclass(frozen=True)
class Target:
    scheme: str
    host: str  # ASCII (IDNA), нижний регистр, без точки в конце
    port: int
    path: str  # путь + «?запрос», начинается с «/»

    @property
    def url(self) -> str:
        default = 443 if self.scheme == "https" else 80
        netloc = self.host if self.port == default else f"{self.host}:{self.port}"
        if ":" in self.host:
            netloc = f"[{self.host}]" + ("" if self.port == default else f":{self.port}")
        return f"{self.scheme}://{netloc}{self.path}"

    @property
    def origin_key(self) -> str:
        return f"{self.scheme}://{self.host}:{self.port}"


_HOST_LABEL = re.compile(r"^[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?$")


def parse_target(url: str, allowed_ports: frozenset[int] = ALLOWED_PORTS) -> Target:
    """Разбор и проверка URL до всякой сети. Бросает FetchError."""
    if not isinstance(url, str) or not url or len(url) > MAX_URL_LENGTH:
        raise FetchError("invalid_url", "Некорректный адрес.")
    if any(ord(ch) < 0x21 or ord(ch) == 0x7F for ch in url) or "\\" in url:
        raise FetchError("invalid_url", "Адрес содержит недопустимые символы.")
    try:
        parts = urlsplit(url)
        port_value = parts.port
    except ValueError:
        raise FetchError("invalid_url", "Некорректный адрес.") from None
    scheme = parts.scheme.lower()
    if scheme not in ("http", "https"):
        raise FetchError("scheme_not_allowed", "Разрешены только http и https.")
    if parts.username is not None or parts.password is not None or "@" in parts.netloc:
        raise FetchError("credentials_in_url", "Учётные данные в адресе запрещены.")
    raw_host = parts.hostname
    if not raw_host:
        raise FetchError("invalid_url", "В адресе нет домена.")
    port = port_value if port_value is not None else (443 if scheme == "https" else 80)
    if port not in allowed_ports:
        raise FetchError("port_not_allowed", "Порт не разрешён: допустимы 80 и 443.")
    host = raw_host.rstrip(".").lower()
    is_ip = False
    try:
        ipaddress.ip_address(host)
        is_ip = True
    except ValueError:
        pass
    if not is_ip:
        try:
            host = host.encode("idna").decode("ascii")
        except UnicodeError:
            raise FetchError("invalid_url", "Некорректное имя домена.") from None
        if len(host) > 253 or not all(_HOST_LABEL.match(label) for label in host.split(".")):
            raise FetchError("invalid_url", "Некорректное имя домена.")
    path = quote(parts.path or "/", safe="/%:@!$&'()*+,;=-._~")
    if not path.startswith("/"):
        path = "/" + path
    if parts.query:
        path += "?" + quote(parts.query, safe="/%:@!$&'()*+,;=-._~?")
    return Target(scheme=scheme, host=host, port=port, path=path)


def safe_url_for_log(url: str) -> str:
    """Схема + хост + путь (без запроса и фрагмента): в логи не попадают токены и ПД."""
    try:
        p = urlsplit(url)
        return f"{p.scheme}://{p.hostname or '?'}{p.path[:80]}"
    except ValueError:
        return "<url>"


# ---------------------------------------------------------------------------------------------
# DNS.

Resolver = Callable[[str], Sequence[str]]


def system_resolver(host: str) -> list[str]:
    """Системный резолв A и AAAA. Возвращает уникальные адреса в порядке выдачи."""
    infos = socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)
    seen: list[str] = []
    for info in infos:
        ip = str(info[4][0]).split("%", 1)[0]
        if ip not in seen:
            seen.append(ip)
    return seen


# ---------------------------------------------------------------------------------------------
# robots.txt.


@dataclass
class RobotsRules:
    rules: list[tuple[bool, re.Pattern[str], int]] = field(default_factory=list)

    def allowed(self, path: str) -> bool:
        best_len = -1
        verdict = True
        for allow, pattern, length in self.rules:
            if pattern.match(path) and (length > best_len or (length == best_len and allow)):
                best_len, verdict = length, allow
        return verdict


def _rule_pattern(value: str) -> re.Pattern[str]:
    anchored = value.endswith("$")
    core = value[:-1] if anchored else value
    regex = ".*".join(re.escape(part) for part in core.split("*"))
    return re.compile(regex + ("$" if anchored else ""))


def parse_robots(text: str, token: str = ROBOTS_TOKEN) -> RobotsRules:
    """Минимальный разбор robots.txt: группы User-agent, Allow/Disallow, `*`, `$`, longest match."""
    groups: list[tuple[list[str], list[tuple[bool, str]]]] = []
    agents: list[str] = []
    rules: list[tuple[bool, str]] = []
    in_rules = False
    for raw in text.splitlines()[:5000]:
        line = raw.split("#", 1)[0].strip()[:2000]
        if ":" not in line:
            continue
        name, _, value = line.partition(":")
        name, value = name.strip().lower(), value.strip()
        if name == "user-agent":
            if in_rules:
                groups.append((agents, rules))
                agents, rules, in_rules = [], [], False
            agents.append(value.lower())
        elif name in ("allow", "disallow") and agents:
            in_rules = True
            if value:  # пустой Disallow = «всё разрешено»
                rules.append((name == "allow", value))
    if agents:
        groups.append((agents, rules))

    def matches(agent: str) -> bool:
        return agent != "*" and agent != "" and agent in token

    specific = [r for a, r in groups if any(matches(x) for x in a)]
    chosen = specific or [r for a, r in groups if "*" in a]
    result = RobotsRules()
    for group in chosen:
        for allow, value in group:
            result.rules.append((allow, _rule_pattern(value), len(value)))
    return result


class RobotsCache:
    """Кэш правил на домен (сутки). Потокобезопасен; ограничен по размеру."""

    def __init__(
        self, ttl: float = ROBOTS_TTL_SECONDS, now: Callable[[], float] = time.time, cap: int = 500
    ) -> None:
        self._ttl = ttl
        self._now = now
        self._cap = cap
        self._data: dict[str, tuple[float, RobotsRules]] = {}
        self._lock = threading.Lock()

    def get(self, key: str) -> RobotsRules | None:
        with self._lock:
            hit = self._data.get(key)
            if hit is None:
                return None
            if self._now() - hit[0] >= self._ttl:
                del self._data[key]
                return None
            return hit[1]

    def put(self, key: str, rules: RobotsRules) -> None:
        with self._lock:
            if len(self._data) >= self._cap:
                oldest = min(self._data, key=lambda k: self._data[k][0])
                del self._data[oldest]
            self._data[key] = (self._now(), rules)


# ---------------------------------------------------------------------------------------------
# Троттлинг и бюджет страниц.


class DomainThrottle:
    """Не чаще одного запроса к домену раз в `interval` секунд (в т.ч. между потоками)."""

    def __init__(
        self,
        interval: float = THROTTLE_SECONDS,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self._interval = interval
        self._clock = clock
        self._sleep = sleep
        self._next: dict[str, float] = {}
        self._lock = threading.Lock()

    def wait(self, host: str) -> float:
        with self._lock:
            now = self._clock()
            slot = max(now, self._next.get(host, 0.0))
            self._next[host] = slot + self._interval
            if len(self._next) > 2000:  # чистим давно прошедшие слоты
                self._next = {h: t for h, t in self._next.items() if t > now}
        delay = slot - now
        if delay > 0:
            self._sleep(delay)
        return max(0.0, delay)


class PageBudget:
    """Не более `max_pages` страниц на домен за одну проверку."""

    def __init__(self, max_pages: int = MAX_PAGES_PER_DOMAIN) -> None:
        self.max_pages = max_pages
        self.used: dict[str, int] = {}

    def take(self, host: str) -> None:
        n = self.used.get(host, 0)
        if n >= self.max_pages:
            raise FetchError("page_budget_exceeded", "Достигнут лимит страниц на домен.")
        self.used[host] = n + 1


# ---------------------------------------------------------------------------------------------
# Соединение с закреплённым IP.

Connector = Callable[[str, int, float], socket.socket]
TlsWrapper = Callable[[socket.socket, str], socket.socket]


def default_connector(ip: str, port: int, timeout: float) -> socket.socket:
    return socket.create_connection((ip, port), timeout=timeout)


def _default_tls_context() -> ssl.SSLContext:
    ctx = ssl.create_default_context()
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    return ctx


class _PinnedConnection(http.client.HTTPConnection):
    """HTTP(S)-соединение с заранее проверенным IP: имя хоста для DNS не используется."""

    def __init__(
        self,
        target: Target,
        ip: str,
        *,
        connector: Connector,
        tls_wrap: TlsWrapper | None,
        limits: FetchLimits,
    ) -> None:
        super().__init__(target.host, target.port, timeout=limits.connect_timeout)
        self._ip = ip
        self._connector = connector
        self._tls_wrap = tls_wrap
        self._limits = limits
        #: Сырой сокет: http.client обнуляет `self.sock` после getresponse() (Connection: close),
        #: а watchdog дедлайна и финальная очистка должны до него дотянуться.
        self.pinned_sock: socket.socket | None = None

    def connect(self) -> None:
        sock = self._connector(self._ip, self.port, self._limits.connect_timeout)
        try:
            sock.settimeout(self._limits.connect_timeout)
            if self._tls_wrap is not None:
                sock = self._tls_wrap(sock, self.host)  # SNI и проверка сертификата — по имени
            sock.settimeout(self._limits.read_timeout)
        except BaseException:
            sock.close()
            raise
        self.pinned_sock = sock
        self.sock = sock


# ---------------------------------------------------------------------------------------------
# Распаковка с ограничением размера.


class _Inflater:
    def __init__(self, encoding: str, limit: int) -> None:
        self._limit = limit
        self._total = 0
        self._raw_retry = encoding == "deflate"
        wbits = zlib.MAX_WBITS | 16 if encoding in ("gzip", "x-gzip") else zlib.MAX_WBITS
        self._d = zlib.decompressobj(wbits)
        self._started = False

    def feed(self, chunk: bytes) -> bytes:
        out = bytearray()
        data = chunk
        try:
            while data:
                piece = self._d.decompress(data, self._limit - self._total + 1)
                self._started = True
                self._total += len(piece)
                if self._total > self._limit:
                    raise FetchError("too_large", "Страница слишком большая.")
                out += piece
                data = self._d.unconsumed_tail
                if not piece and not data:
                    break
        except zlib.error:
            if self._raw_retry and not self._started:  # «deflate» без zlib-заголовка
                self._raw_retry = False
                self._d = zlib.decompressobj(-zlib.MAX_WBITS)
                return self.feed(chunk)
            raise FetchError("decompress_error", "Не удалось распаковать ответ.") from None
        return bytes(out)


@dataclass
class FetchResult:
    url: str  # итоговый URL после редиректов
    status: int
    content_type: str
    charset: str | None
    body: bytes
    redirects: int = 0
    ip: str = ""


@dataclass
class _Raw:
    status: int
    headers: dict[str, str]
    body: bytes
    ip: str


class SafeFetcher:
    """Загрузчик публичных страниц. Один экземпляр на процесс (кэш robots и троттлинг общие)."""

    def __init__(
        self,
        *,
        allow_private: bool = False,
        allowed_ports: frozenset[int] = ALLOWED_PORTS,
        limits: FetchLimits | None = None,
        resolver: Resolver | None = None,
        connector: Connector | None = None,
        tls_wrap: TlsWrapper | None = None,
        throttle: DomainThrottle | None = None,
        robots: RobotsCache | None = None,
        clock: Callable[[], float] = time.monotonic,
        user_agent: str = USER_AGENT,
    ) -> None:
        self.allow_private = allow_private
        self.allowed_ports = allowed_ports
        self.limits = limits or FetchLimits()
        self._resolver: Resolver = resolver or system_resolver
        self._connector: Connector = connector or default_connector
        if tls_wrap is None:
            ctx = _default_tls_context()
            self._tls_wrap: TlsWrapper = lambda s, host: ctx.wrap_socket(s, server_hostname=host)
        else:
            self._tls_wrap = tls_wrap
        self.throttle = throttle or DomainThrottle()
        self.robots = robots or RobotsCache()
        self._clock = clock
        self.user_agent = user_agent

    # -- DNS ------------------------------------------------------------------------------

    def resolve(self, host: str) -> list[str]:
        """Резолв и проверка ВСЕХ адресов. Любой запрещённый адрес — отказ для всего хоста."""
        try:
            ipaddress.ip_address(host)
            addresses: list[str] = [host]
        except ValueError:
            try:
                addresses = [a.split("%", 1)[0] for a in self._resolver(host)]
            except socket.gaierror as exc:
                if exc.errno in (socket.EAI_NONAME, getattr(socket, "EAI_NODATA", -5)):
                    raise FetchError("dns_not_found", "Домен сайта не существует.") from None
                raise FetchError(
                    "dns_failed", "Не удалось определить адрес сайта.", retryable=True
                ) from None
            except (OSError, UnicodeError):
                raise FetchError(
                    "dns_failed", "Не удалось определить адрес сайта.", retryable=True
                ) from None
        if not addresses:
            raise FetchError("dns_failed", "Не удалось определить адрес сайта.", retryable=True)
        if not self.allow_private:
            for a in addresses:
                if ip_string_is_blocked(a):
                    raise FetchError("host_blocked", "Адрес сайта недопустим для загрузки.")
        return addresses

    # -- один запрос ------------------------------------------------------------------------

    def _request(self, target: Target, kind: str, deadline: float) -> _Raw:
        addresses = self.resolve(target.host)
        self.throttle.wait(target.host)
        last: FetchError | None = None
        for ip in addresses[:4]:
            try:
                return self._request_ip(target, ip, kind, deadline)
            except FetchError as exc:
                if exc.code != "connect_failed":
                    raise
                last = exc
        raise last or FetchError("connect_failed", "Не удалось подключиться.", retryable=True)

    def _request_ip(self, target: Target, ip: str, kind: str, deadline: float) -> _Raw:
        remaining = deadline - self._clock()
        if remaining <= 0:
            raise FetchError("deadline", "Превышено общее время загрузки.", retryable=True)
        limits = self.limits
        conn = _PinnedConnection(
            target,
            ip,
            connector=self._connector,
            tls_wrap=self._tls_wrap if target.scheme == "https" else None,
            limits=limits,
        )
        expired = threading.Event()

        def kill() -> None:  # watchdog общего дедлайна: рвёт соединение, где бы оно ни зависло
            expired.set()
            sock = conn.pinned_sock
            if sock is not None:
                with contextlib.suppress(OSError):
                    sock.shutdown(socket.SHUT_RDWR)
                sock.close()

        timer = threading.Timer(remaining, kill)
        timer.daemon = True
        timer.start()
        try:
            return self._exchange(conn, target, ip, kind, expired)
        except FetchError:
            if expired.is_set():
                raise FetchError(
                    "deadline", "Превышено общее время загрузки.", retryable=True
                ) from None
            raise
        except TimeoutError:
            raise FetchError("timeout", "Сайт отвечает слишком медленно.", retryable=True) from None
        except ssl.SSLError:
            raise FetchError("tls_error", "Ошибка TLS или сертификата сайта.") from None
        except (OSError, http.client.HTTPException, ValueError):
            if expired.is_set():
                raise FetchError(
                    "deadline", "Превышено общее время загрузки.", retryable=True
                ) from None
            raise FetchError("connect_failed", "Не удалось получить ответ сайта.",
                             retryable=True) from None  # fmt: skip
        finally:
            timer.cancel()
            conn.close()
            if conn.pinned_sock is not None:
                conn.pinned_sock.close()

    def _exchange(
        self, conn: _PinnedConnection, target: Target, ip: str, kind: str, expired: threading.Event
    ) -> _Raw:
        limits = self.limits
        accept = "text/plain" if kind == "robots" else "text/html,application/xhtml+xml;q=0.9"
        host_header = target.host if target.port in (80, 443) else f"{target.host}:{target.port}"
        if ":" in target.host:
            host_header = f"[{target.host}]"
        conn.putrequest("GET", target.path, skip_host=True, skip_accept_encoding=True)
        conn.putheader("Host", host_header)
        conn.putheader("User-Agent", self.user_agent)
        conn.putheader("Accept", accept)
        conn.putheader("Accept-Encoding", "gzip, deflate")
        conn.putheader("Accept-Language", "ru,en;q=0.5")
        conn.putheader("Connection", "close")
        conn.endheaders()  # connect() произойдёт здесь: соединение с закреплённым IP
        resp = conn.getresponse()
        status = resp.status
        headers = {k.lower(): v for k, v in resp.getheaders() if k.lower() != "set-cookie"}
        if status in REDIRECT_STATUSES:
            return _Raw(status, headers, b"", ip)
        if status != 200:
            return _Raw(status, headers, b"", ip)  # тело не читаем
        ctype = headers.get("content-type", "").split(";", 1)[0].strip().lower()
        allowed = ROBOTS_TYPES if kind == "robots" else HTML_TYPES
        if ctype not in allowed:
            raise FetchError("content_type_not_allowed", "Тип содержимого не разрешён.")
        declared = headers.get("content-length", "")
        if declared.isdigit() and int(declared) > limits.max_body_bytes:
            raise FetchError("too_large", "Страница слишком большая.")
        encoding = headers.get("content-encoding", "").strip().lower()
        if encoding in ("", "identity"):
            inflater: _Inflater | None = None
        elif encoding in ("gzip", "x-gzip", "deflate"):
            inflater = _Inflater(encoding, limits.max_body_bytes)
        else:
            raise FetchError("encoding_unsupported", "Сжатие ответа не поддерживается.")
        parts: list[bytes] = []
        raw_total = 0
        decoded_total = 0
        try:
            while True:
                chunk = resp.read1(16384)
                if not chunk:
                    break
                raw_total += len(chunk)
                if raw_total > limits.max_body_bytes:
                    raise FetchError("too_large", "Страница слишком большая.")
                piece = inflater.feed(chunk) if inflater else chunk
                decoded_total += len(piece)
                if decoded_total > limits.max_body_bytes:
                    raise FetchError("too_large", "Страница слишком большая.")
                parts.append(piece)
        except http.client.IncompleteRead:
            if expired.is_set():
                raise
            raise FetchError("incomplete", "Ответ сайта оборван.", retryable=True) from None
        if expired.is_set():  # watchdog оборвал чтение: обрезанное тело не отдаём
            raise FetchError("deadline", "Превышено общее время загрузки.", retryable=True)
        return _Raw(status, headers, b"".join(parts), ip)

    # -- цепочка редиректов ------------------------------------------------------------------

    def _get(
        self,
        url: str,
        kind: str,
        *,
        respect_robots: bool = True,
        budget: PageBudget | None = None,
    ) -> FetchResult:
        deadline = self._clock() + self.limits.total_deadline
        current = url
        for hop in range(self.limits.max_redirects + 1):
            target = parse_target(current, self.allowed_ports)
            if kind == "page":
                if respect_robots:
                    self._check_robots(target)
                if budget is not None and hop == 0:
                    budget.take(target.host)
            raw = self._request(target, kind, deadline)
            if raw.status in REDIRECT_STATUSES:
                location = raw.headers.get("location", "").strip()
                if not location:
                    raise FetchError("redirect_invalid", "Редирект без адреса.")
                if hop >= self.limits.max_redirects:
                    raise FetchError("too_many_redirects", "Слишком много редиректов.")
                current = urljoin(target.url, location.split("#", 1)[0])
                continue
            ctype = raw.headers.get("content-type", "")
            media = ctype.split(";", 1)[0].strip().lower()
            charset = None
            m = re.search(r"charset=\"?([A-Za-z0-9_.:-]+)", ctype, re.IGNORECASE)
            if m:
                charset = m.group(1).lower()
            return FetchResult(
                url=target.url,
                status=raw.status,
                content_type=media,
                charset=charset,
                body=raw.body,
                redirects=hop,
                ip=raw.ip,
            )
        raise FetchError("too_many_redirects", "Слишком много редиректов.")  # pragma: no cover

    # -- robots ---------------------------------------------------------------------------------

    def _check_robots(self, target: Target) -> None:
        rules = self.robots.get(target.origin_key)
        if rules is None:
            rules = self._load_robots(target)
            self.robots.put(target.origin_key, rules)
        if not rules.allowed(target.path):
            raise FetchError("robots_disallowed", "robots.txt сайта запрещает загрузку страницы.")

    def _load_robots(self, target: Target) -> RobotsRules:
        robots_url = Target(target.scheme, target.host, target.port, "/robots.txt").url
        try:
            res = self._get(robots_url, "robots")
        except FetchError as exc:
            if exc.code in (
                "host_blocked",
                "invalid_url",
                "port_not_allowed",
                "scheme_not_allowed",
            ):
                raise
            if exc.code == "content_type_not_allowed":
                return RobotsRules()  # не text/plain — правил нет
            raise FetchError(
                "robots_unavailable", "Не удалось получить robots.txt.", retryable=True
            ) from None
        if res.status == 200:
            return parse_robots(res.body.decode("utf-8", errors="replace"))
        if 400 <= res.status < 500:
            return RobotsRules()  # файла нет — ограничений нет
        raise FetchError("robots_unavailable", "Не удалось получить robots.txt.", retryable=True)

    # -- публичный API --------------------------------------------------------------------------

    def fetch_page(
        self, url: str, *, budget: PageBudget | None = None, respect_robots: bool = True
    ) -> FetchResult:
        """Загружает HTML-страницу. Бросает FetchError. Статус не 200 — тоже FetchError."""
        res = self._get(url, "page", respect_robots=respect_robots, budget=budget)
        if res.status != 200:
            transient = res.status == 429 or res.status >= 500
            raise FetchError(
                "http_error", f"Сайт ответил статусом {res.status}.", retryable=transient
            )
        log.info(
            "fetched host=%s status=%s bytes=%s",
            safe_url_for_log(res.url),
            res.status,
            len(res.body),
        )
        return res
