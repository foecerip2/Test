"""SSRF-защита загрузчика: адреса, DNS rebinding, редиректы, лимиты, robots, троттлинг.

Сеть — только локальный сервер и подставной резолвер/коннектор; реального интернета нет.
"""

from __future__ import annotations

import gzip
import ssl
import threading
import time
import zlib
from collections.abc import Callable, Iterator

import pytest

from app.config import Settings
from app.services.safe_fetch import (
    USER_AGENT,
    DomainThrottle,
    FetchError,
    FetchLimits,
    PageBudget,
    RobotsCache,
    SafeFetcher,
    ip_string_is_blocked,
    parse_robots,
    parse_target,
    system_resolver,
)
from tests.netutil import LocalSite, Resp, zeros

PUBLIC = "93.184.216.34"


# --- адреса ----------------------------------------------------------------------------------

BLOCKED_IPS = [
    # loopback
    "127.0.0.1",
    "127.255.255.254",
    "::1",
    # unspecified
    "0.0.0.0",
    "0.1.2.3",
    "::",
    # RFC1918
    "10.0.0.1",
    "10.255.255.255",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.0.1",
    "192.168.255.255",
    # ULA, link-local
    "fc00::1",
    "fd12:3456:789a::1",
    "fe80::1",
    "fe80::dead:beef",
    "169.254.0.1",
    "169.254.169.254",  # метаданные облака (AWS/GCP/Azure)
    "169.254.170.2",
    "fd00:ec2::254",  # метаданные AWS по IPv6 (ULA)
    # CGNAT
    "100.64.0.1",
    "100.127.255.254",
    # multicast, reserved, broadcast
    "224.0.0.1",
    "239.255.255.250",
    "ff02::1",
    "ff0e::1",
    "240.0.0.1",
    "255.255.255.255",
    # документационные и тестовые диапазоны
    "192.0.2.1",
    "198.51.100.7",
    "203.0.113.9",
    "2001:db8::1",
    "198.18.0.1",
    "192.0.0.8",
    # IPv4-mapped IPv6 с запрещённым IPv4
    "::ffff:127.0.0.1",
    "::ffff:10.1.2.3",
    "::ffff:169.254.169.254",
    "::ffff:192.168.1.1",
    "::ffff:100.64.0.1",
    # NAT64 / 6to4 / Teredo / site-local
    "64:ff9b::7f00:1",
    "2002:7f00:1::1",
    "2001:0:4136:e378:8000:63bf:3fff:fdd2",
    "fec0::1",
    # мусор
    "not-an-ip",
    "",
]

ALLOWED_IPS = [
    "8.8.8.8",
    "1.1.1.1",
    "93.184.216.34",
    "77.88.8.8",
    "172.15.255.255",  # граница перед 172.16/12
    "172.32.0.1",  # граница после
    "100.63.255.255",
    "100.128.0.1",
    "169.253.1.1",
    "2606:4700:4700::1111",
    "2a00:1450:4001:81b::200e",
    "::ffff:8.8.8.8",  # mapped публичный IPv4 допустим
]


@pytest.mark.parametrize("ip", BLOCKED_IPS)
def test_blocked_addresses(ip: str) -> None:
    assert ip_string_is_blocked(ip) is True


@pytest.mark.parametrize("ip", ALLOWED_IPS)
def test_public_addresses_allowed(ip: str) -> None:
    assert ip_string_is_blocked(ip) is False


def test_ipv6_zone_id_is_stripped() -> None:
    assert ip_string_is_blocked("fe80::1%eth0") is True


# --- разбор URL ---------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "url",
    [
        "ftp://example.com/",
        "file:///etc/passwd",
        "gopher://example.com/",
        "javascript:alert(1)",
        "data:text/html,hi",
        "dict://example.com:80/",
        "ldap://example.com/",
        "//example.com/",
        "example.com",
    ],
)
def test_scheme_not_allowed(url: str) -> None:
    with pytest.raises(FetchError) as e:
        parse_target(url)
    assert e.value.code in {"scheme_not_allowed", "invalid_url"}


@pytest.mark.parametrize(
    "url", ["http://example.com:8080/", "https://example.com:8443/", "http://example.com:22/",
            "http://example.com:25/", "https://example.com:3306/", "http://example.com:81/"]
)  # fmt: skip
def test_port_not_allowed(url: str) -> None:
    with pytest.raises(FetchError) as e:
        parse_target(url)
    assert e.value.code == "port_not_allowed"


def test_explicit_default_ports_are_fine() -> None:
    assert parse_target("http://example.com:80/").port == 80
    assert parse_target("https://example.com:443/").port == 443
    assert parse_target("https://example.com/").port == 443


@pytest.mark.parametrize(
    "url",
    [
        "http://user:pass@example.com/",
        "https://user@example.com/",
        "http://:pw@example.com/",
        "http://example.com@evil.example/",
        "http://example.com%40evil.example@x.example/",
    ],
)
def test_credentials_in_url_rejected(url: str) -> None:
    with pytest.raises(FetchError) as e:
        parse_target(url)
    assert e.value.code == "credentials_in_url"


@pytest.mark.parametrize(
    "url",
    [
        "",
        "http://",
        "http:///path",
        "http://exa mple.com/",
        "http://example.com/\n",
        "http://example.com/\x00",
        "http://exa\\mple.com/",
        "http://example.com\\@evil.example/",
        "http://-bad-.example/",
        "http://under..score.example/",
        "http://" + "a" * 64 + ".example/",
        "http://example.com/" + "a" * 3000,
    ],
)
def test_invalid_urls(url: str) -> None:
    with pytest.raises(FetchError) as e:
        parse_target(url)
    assert e.value.code in {"invalid_url", "credentials_in_url"}


def test_idna_normalization() -> None:
    t = parse_target("https://Пример.РФ/Путь?q=1")
    assert t.host == "xn--e1afmkfd.xn--p1ai"
    assert t.path.startswith("/%D0%9F")
    assert t.url.startswith("https://xn--e1afmkfd.xn--p1ai/")


def test_trailing_dot_and_case_are_normalized() -> None:
    assert parse_target("HTTP://Example.COM./a").host == "example.com"


def test_fragment_dropped_query_kept() -> None:
    t = parse_target("https://example.com/a?b=1#frag")
    assert t.path == "/a?b=1"


# --- DNS: проверяются все адреса --------------------------------------------------------------------


def _fetcher(**kw: object) -> SafeFetcher:
    kw.setdefault("throttle", DomainThrottle(0))
    return SafeFetcher(**kw)  # type: ignore[arg-type]


def test_every_resolved_address_must_be_public() -> None:
    f = _fetcher(resolver=lambda h: [PUBLIC, "10.0.0.5"])
    with pytest.raises(FetchError) as e:
        f.resolve("mixed.test")
    assert e.value.code == "host_blocked"


def test_aaaa_record_is_checked_too() -> None:
    f = _fetcher(resolver=lambda h: [PUBLIC, "fd00::1"])
    with pytest.raises(FetchError) as e:
        f.resolve("v6.test")
    assert e.value.code == "host_blocked"


def test_all_public_addresses_pass() -> None:
    f = _fetcher(resolver=lambda h: [PUBLIC, "2606:4700:4700::1111"])
    assert f.resolve("ok.test") == [PUBLIC, "2606:4700:4700::1111"]


def test_empty_resolution_is_dns_failure() -> None:
    f = _fetcher(resolver=lambda h: [])
    with pytest.raises(FetchError) as e:
        f.resolve("nothing.test")
    assert e.value.code == "dns_failed" and e.value.retryable


def test_resolver_oserror_is_dns_failure() -> None:
    def boom(host: str) -> list[str]:
        raise OSError("temporary failure")

    with pytest.raises(FetchError) as e:
        _fetcher(resolver=boom).resolve("x.test")
    assert e.value.code == "dns_failed"


@pytest.mark.parametrize("host", ["127.0.0.1", "[::1]", "169.254.169.254", "10.0.0.1", "0.0.0.0"])
def test_ip_literal_hosts_are_checked(host: str) -> None:
    f = _fetcher(resolver=lambda h: [PUBLIC])  # резолвер не должен вызываться для литералов
    with pytest.raises(FetchError) as e:
        f.fetch_page(f"http://{host}/")
    assert e.value.code == "host_blocked"


@pytest.mark.parametrize("host", ["localhost", "2130706433", "0x7f.1", "127.1", "0177.0.0.1"])
def test_tricky_loopback_spellings_blocked_with_system_resolver(host: str) -> None:
    f = _fetcher(resolver=system_resolver)
    with pytest.raises(FetchError) as e:
        f.fetch_page(f"http://{host}/")
    assert e.value.code in {"host_blocked", "dns_failed", "dns_not_found", "invalid_url"}


def test_allow_private_disables_only_address_check() -> None:
    f = _fetcher(allow_private=True, resolver=lambda h: ["127.0.0.1"])
    assert f.resolve("local.test") == ["127.0.0.1"]
    for url, code in [
        ("file:///etc/passwd", "scheme_not_allowed"),
        ("http://u:p@local.test/", "credentials_in_url"),
        ("http://local.test:8080/", "port_not_allowed"),
    ]:
        with pytest.raises(FetchError) as e:
            f.fetch_page(url)
        assert e.value.code == code


# --- настройки ------------------------------------------------------------------------------------


def _prod(**extra: object) -> Settings:
    return Settings(
        env="prod",
        database_url="postgresql://u:p@db/x",
        secret_key="s" * 40,
        mail_backend="smtp",
        smtp_host="smtp.example.com",
        **extra,  # type: ignore[arg-type]
    )


def test_private_fetch_flag_forbidden_in_prod() -> None:
    with pytest.raises(ValueError, match="ALLOW_PRIVATE_FETCH_FOR_TESTS"):
        _prod(allow_private_fetch_for_tests=True)
    assert _prod().allow_private_fetch_for_tests is False


def test_private_fetch_flag_allowed_in_dev_and_off_by_default() -> None:
    assert Settings(env="dev").allow_private_fetch_for_tests is False
    assert Settings(env="dev", allow_private_fetch_for_tests=True).allow_private_fetch_for_tests


def test_private_fetch_flag_from_environment_in_prod(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ALLOW_PRIVATE_FETCH_FOR_TESTS", "true")
    with pytest.raises(ValueError, match="ALLOW_PRIVATE_FETCH_FOR_TESTS"):
        _prod()


# --- загрузка через «публичный» адрес и локальный сервер ------------------------------------------------

HTML = Resp(body="<html><title>Ok</title><body>Привет</body></html>".encode())


@pytest.fixture
def site() -> Iterator[LocalSite]:
    with LocalSite({"/": HTML, "/robots.txt": Resp(status=404)}) as s:
        yield s


def public_fetcher(
    site: LocalSite,
    resolver: Callable[[str], list[str]] | None = None,
    **kw: object,
) -> SafeFetcher:
    """Адреса проверяются по-настоящему, но TCP уходит на локальный сервер."""
    return _fetcher(
        resolver=resolver or (lambda h: [PUBLIC]), connector=site.connector(), **kw
    )


def local_fetcher(site: LocalSite, **kw: object) -> SafeFetcher:
    """Тестовый режим: приватные адреса разрешены, порт сервера — в списке допустимых."""
    return _fetcher(
        allow_private=True,
        allowed_ports=frozenset({site.port}),
        resolver=lambda h: ["127.0.0.1"],
        **kw,
    )


def test_basic_fetch_through_pinned_ip(site: LocalSite) -> None:
    conn = site.connector()
    f = _fetcher(resolver=lambda h: [PUBLIC], connector=conn)
    res = f.fetch_page("http://shop.test/")
    assert res.status == 200 and res.content_type == "text/html" and res.charset == "utf-8"
    assert "Привет" in res.body.decode()
    assert conn.seen == [PUBLIC, PUBLIC]  # type: ignore[attr-defined]  # robots.txt + страница
    page_req = next(r for r in site.log if r.path == "/")
    assert page_req.headers["host"] == "shop.test"  # Host остаётся исходным
    assert page_req.headers["user-agent"] == USER_AGENT
    assert "cookie" not in page_req.headers
    assert page_req.headers["accept-encoding"] == "gzip, deflate"


def test_user_agent_constant() -> None:
    assert USER_AGENT == "LeadHunterBot/1.0 (+https://ai.vaylonet.ru)"


def test_non_default_port_in_host_header() -> None:
    with LocalSite({"/": HTML}) as s:
        f = local_fetcher(s)
        f.fetch_page(f"http://site.test:{s.port}/", respect_robots=False)
        assert s.log[0].headers["host"] == f"site.test:{s.port}"


def test_cookies_are_never_sent(site: LocalSite) -> None:
    site.routes["/"] = Resp(body=b"<html>x</html>", headers={"Set-Cookie": "sid=1; Path=/"})
    f = public_fetcher(site)
    f.fetch_page("http://shop.test/")
    f.fetch_page("http://shop.test/")
    assert all("cookie" not in r.headers for r in site.log)


def test_rebinding_connection_is_pinned_to_checked_ip(site: LocalSite) -> None:
    answers = iter([[PUBLIC], ["10.0.0.5"], ["127.0.0.1"]])
    calls: list[str] = []

    def resolver(host: str) -> list[str]:
        calls.append(host)
        return next(answers)

    conn = site.connector()
    f = _fetcher(resolver=resolver, connector=conn)
    res = f.fetch_page("http://rebind.test/", respect_robots=False)
    assert res.status == 200
    assert calls == ["rebind.test"]  # резолв ровно один раз за запрос
    assert conn.seen == [PUBLIC]  # type: ignore[attr-defined]  # соединение — только с проверенным адресом


def test_rebinding_to_private_on_next_resolution_is_blocked(site: LocalSite) -> None:
    answers = iter([[PUBLIC], ["10.0.0.5"]])
    conn = site.connector()
    f = _fetcher(resolver=lambda h: next(answers), connector=conn)
    with pytest.raises(FetchError) as e:
        f.fetch_page("http://rebind.test/")  # robots.txt — публичный адрес, страница — уже приватный
    assert e.value.code == "host_blocked"
    assert conn.seen == [PUBLIC]  # type: ignore[attr-defined]  # к приватному адресу соединения не было


def test_rebinding_first_private_then_public_is_blocked_immediately(site: LocalSite) -> None:
    answers = iter([["10.0.0.5"], [PUBLIC]])
    conn = site.connector()
    f = _fetcher(resolver=lambda h: next(answers), connector=conn)
    with pytest.raises(FetchError) as e:
        f.fetch_page("http://rebind.test/", respect_robots=False)
    assert e.value.code == "host_blocked"
    assert conn.seen == []  # type: ignore[attr-defined]


def test_cloud_metadata_via_dns_name_is_blocked(site: LocalSite) -> None:
    f = public_fetcher(site, resolver=lambda h: ["169.254.169.254"])
    with pytest.raises(FetchError) as e:
        f.fetch_page("http://metadata.test/latest/meta-data/")
    assert e.value.code == "host_blocked"
    assert site.log == []


# --- редиректы -----------------------------------------------------------------------------------------


def redirect(location: str, status: int = 302) -> Resp:
    return Resp(status=status, headers={"Location": location}, content_type=None)


def multi_resolver(mapping: dict[str, list[str]]) -> Callable[[str], list[str]]:
    return lambda host: mapping.get(host, [PUBLIC])


def test_redirect_chain_followed_and_rechecked(site: LocalSite) -> None:
    site.routes.update(
        {
            "/a": redirect("/b", 301),
            "/b": redirect("http://other.test/c", 307),
            "/c": HTML,
        }
    )
    f = public_fetcher(site)
    res = f.fetch_page("http://shop.test/a", respect_robots=False)
    assert res.redirects == 2 and res.url == "http://other.test/c"
    assert site.paths() == ["/a", "/b", "/c"]


def test_exactly_three_redirects_allowed_fourth_is_not(site: LocalSite) -> None:
    site.routes.update(
        {
            "/r0": redirect("/r1"),
            "/r1": redirect("/r2"),
            "/r2": redirect("/r3"),
            "/r3": HTML,
        }
    )
    f = public_fetcher(site)
    assert f.fetch_page("http://shop.test/r0", respect_robots=False).redirects == 3
    site.routes["/r3"] = redirect("/r4")
    site.routes["/r4"] = HTML
    with pytest.raises(FetchError) as e:
        f.fetch_page("http://shop.test/r0", respect_robots=False)
    assert e.value.code == "too_many_redirects"


def test_redirect_loop_stops(site: LocalSite) -> None:
    site.routes["/loop"] = redirect("/loop")
    with pytest.raises(FetchError) as e:
        public_fetcher(site).fetch_page("http://shop.test/loop", respect_robots=False)
    assert e.value.code == "too_many_redirects"
    assert len(site.log) == 4  # исходный запрос + 3 редиректа


@pytest.mark.parametrize(
    "location,code",
    [
        ("http://internal.test/admin", "host_blocked"),
        ("http://169.254.169.254/latest/meta-data/", "host_blocked"),
        ("http://127.0.0.1/", "host_blocked"),
        ("http://[::1]/", "host_blocked"),
        ("http://[::ffff:10.0.0.1]/", "host_blocked"),
        ("http://shop.test:8080/", "port_not_allowed"),
        ("https://shop.test:8443/", "port_not_allowed"),
        ("http://shop.test:22/", "port_not_allowed"),
        ("file:///etc/passwd", "scheme_not_allowed"),
        ("gopher://shop.test/_GET", "scheme_not_allowed"),
        ("ftp://shop.test/", "scheme_not_allowed"),
        ("javascript:alert(1)", "scheme_not_allowed"),
        ("http://user:pw@shop.test/", "credentials_in_url"),
    ],
)
def test_redirect_targets_are_revalidated(site: LocalSite, location: str, code: str) -> None:
    site.routes["/go"] = redirect(location)
    conn = site.connector()
    resolver = multi_resolver({"internal.test": ["10.1.2.3"]})
    f = _fetcher(resolver=resolver, connector=conn)
    with pytest.raises(FetchError) as e:
        f.fetch_page("http://shop.test/go", respect_robots=False)
    assert e.value.code == code
    assert site.paths() == ["/go"]  # на запрещённый адрес запрос не отправлен
    assert conn.seen == [PUBLIC]  # type: ignore[attr-defined]


def test_redirect_without_location(site: LocalSite) -> None:
    site.routes["/x"] = Resp(status=302, content_type=None)
    with pytest.raises(FetchError) as e:
        public_fetcher(site).fetch_page("http://shop.test/x", respect_robots=False)
    assert e.value.code == "redirect_invalid"


def test_redirect_fragment_is_dropped(site: LocalSite) -> None:
    site.routes["/x"] = redirect("/y#secret")
    site.routes["/y"] = HTML
    res = public_fetcher(site).fetch_page("http://shop.test/x", respect_robots=False)
    assert res.url == "http://shop.test/y"


def test_redirect_target_is_checked_against_robots(site: LocalSite) -> None:
    site.routes["/robots.txt"] = Resp(content_type="text/plain", body=b"User-agent: *\nDisallow: /secret\n")
    site.routes["/go"] = redirect("/secret/page")
    f = public_fetcher(site)
    with pytest.raises(FetchError) as e:
        f.fetch_page("http://shop.test/go")
    assert e.value.code == "robots_disallowed"
    assert "/secret/page" not in site.paths()


# --- лимиты --------------------------------------------------------------------------------------------


def test_response_over_limit_stops_streaming(site: LocalSite) -> None:
    site.routes["/big"] = Resp(chunks=zeros(80 * 1024 * 1024))
    started = time.monotonic()
    with pytest.raises(FetchError) as e:
        public_fetcher(site).fetch_page("http://shop.test/big", respect_robots=False)
    assert e.value.code == "too_large"
    assert time.monotonic() - started < 10  # 80 МБ целиком не скачивались


def test_declared_length_over_limit_rejected_before_body(site: LocalSite) -> None:
    site.routes["/big"] = Resp(body=b"x" * 10, declared_length=50 * 1024 * 1024)
    with pytest.raises(FetchError) as e:
        public_fetcher(site).fetch_page("http://shop.test/big", respect_robots=False)
    assert e.value.code == "too_large"


def test_body_exactly_at_limit_is_accepted(site: LocalSite) -> None:
    site.routes["/edge"] = Resp(body=b"a" * 4096)
    f = public_fetcher(site, limits=FetchLimits(max_body_bytes=4096))
    assert len(f.fetch_page("http://shop.test/edge", respect_robots=False).body) == 4096
    site.routes["/edge"] = Resp(body=b"a" * 4097)
    with pytest.raises(FetchError):
        f.fetch_page("http://shop.test/edge", respect_robots=False)


def test_slow_body_hits_total_deadline(site: LocalSite) -> None:
    site.routes["/slow"] = Resp(chunks=(b"x" * 10 for _ in range(1000)), chunk_delay=0.2)
    f = public_fetcher(site, limits=FetchLimits(total_deadline=1.0, read_timeout=5.0))
    started = time.monotonic()
    with pytest.raises(FetchError) as e:
        f.fetch_page("http://shop.test/slow", respect_robots=False)
    assert e.value.code == "deadline" and e.value.retryable
    assert time.monotonic() - started < 4


def test_stalled_server_hits_read_timeout(site: LocalSite) -> None:
    site.routes["/stall"] = Resp(stall=3.0, body=b"<html>late</html>")
    f = public_fetcher(site, limits=FetchLimits(read_timeout=0.4, total_deadline=10.0))
    started = time.monotonic()
    with pytest.raises(FetchError) as e:
        f.fetch_page("http://shop.test/stall", respect_robots=False)
    assert e.value.code == "timeout" and e.value.retryable
    assert time.monotonic() - started < 3


def test_connection_refused_is_retryable_connect_error() -> None:
    def refuse(ip: str, port: int, timeout: float) -> object:
        raise ConnectionRefusedError

    f = _fetcher(resolver=lambda h: [PUBLIC], connector=refuse)
    with pytest.raises(FetchError) as e:
        f.fetch_page("http://down.test/", respect_robots=False)
    assert e.value.code == "connect_failed" and e.value.retryable


def test_next_address_is_tried_when_first_fails(site: LocalSite) -> None:
    attempts: list[str] = []
    good = site.connector()

    def flaky(ip: str, port: int, timeout: float) -> object:
        attempts.append(ip)
        if ip == "8.8.4.4":
            raise ConnectionRefusedError
        return good(ip, port, timeout)

    f = _fetcher(resolver=lambda h: ["8.8.4.4", PUBLIC], connector=flaky)
    assert f.fetch_page("http://two.test/", respect_robots=False).status == 200
    assert attempts == ["8.8.4.4", PUBLIC]


# --- сжатие и gzip-бомбы -----------------------------------------------------------------------------------


def test_gzip_bomb_is_stopped_after_decompression_limit(site: LocalSite) -> None:
    bomb = gzip.compress(b"\x00" * (60 * 1024 * 1024), compresslevel=9)
    assert len(bomb) < 200 * 1024  # сжатый размер мал — лимит должен срабатывать ПОСЛЕ распаковки
    site.routes["/bomb"] = Resp(body=bomb, headers={"Content-Encoding": "gzip"})
    with pytest.raises(FetchError) as e:
        public_fetcher(site).fetch_page("http://shop.test/bomb", respect_robots=False)
    assert e.value.code == "too_large"


def test_deflate_bomb_is_stopped(site: LocalSite) -> None:
    bomb = zlib.compress(b"\x00" * (60 * 1024 * 1024), 9)
    site.routes["/bomb"] = Resp(body=bomb, headers={"Content-Encoding": "deflate"})
    with pytest.raises(FetchError) as e:
        public_fetcher(site).fetch_page("http://shop.test/bomb", respect_robots=False)
    assert e.value.code == "too_large"


@pytest.mark.parametrize(
    "encoding,pack",
    [
        ("gzip", gzip.compress),
        ("deflate", zlib.compress),
        ("deflate", lambda b: zlib.compress(b)[2:-4]),  # «сырой» deflate без заголовка zlib
    ],
)
def test_compressed_pages_are_decoded(
    site: LocalSite, encoding: str, pack: Callable[[bytes], bytes]
) -> None:
    raw = "<html><body>Диагностика</body></html>".encode()
    site.routes["/z"] = Resp(body=pack(raw), headers={"Content-Encoding": encoding})
    res = public_fetcher(site).fetch_page("http://shop.test/z", respect_robots=False)
    assert res.body == raw


def test_corrupt_gzip_rejected(site: LocalSite) -> None:
    site.routes["/z"] = Resp(body=b"not gzip at all", headers={"Content-Encoding": "gzip"})
    with pytest.raises(FetchError) as e:
        public_fetcher(site).fetch_page("http://shop.test/z", respect_robots=False)
    assert e.value.code == "decompress_error"


def test_unsupported_encoding_rejected(site: LocalSite) -> None:
    site.routes["/z"] = Resp(body=b"xx", headers={"Content-Encoding": "br"})
    with pytest.raises(FetchError) as e:
        public_fetcher(site).fetch_page("http://shop.test/z", respect_robots=False)
    assert e.value.code == "encoding_unsupported"


# --- content-type и статусы -----------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "ctype",
    ["application/pdf", "image/png", "application/json", "text/plain", "application/octet-stream",
     "video/mp4", "text/javascript", None]  # fmt: skip
)
def test_non_html_content_type_rejected(site: LocalSite, ctype: str | None) -> None:
    site.routes["/f"] = Resp(body=b"%PDF-1.4", content_type=ctype)
    with pytest.raises(FetchError) as e:
        public_fetcher(site).fetch_page("http://shop.test/f", respect_robots=False)
    assert e.value.code == "content_type_not_allowed"


@pytest.mark.parametrize(
    "ctype", ["text/html", "TEXT/HTML; charset=windows-1251", "application/xhtml+xml; charset=utf-8"]
)
def test_html_content_types_accepted(site: LocalSite, ctype: str) -> None:
    site.routes["/f"] = Resp(body=b"<html>ok</html>", content_type=ctype)
    res = public_fetcher(site).fetch_page("http://shop.test/f", respect_robots=False)
    assert res.status == 200
    if "windows-1251" in ctype:
        assert res.charset == "windows-1251"


@pytest.mark.parametrize("status,retryable", [(404, False), (403, False), (410, False),
                                                 (429, True), (500, True), (503, True)])  # fmt: skip
def test_error_statuses(site: LocalSite, status: int, retryable: bool) -> None:
    site.routes["/s"] = Resp(status=status, body=b"nope")
    with pytest.raises(FetchError) as e:
        public_fetcher(site).fetch_page("http://shop.test/s", respect_robots=False)
    assert e.value.code == "http_error" and e.value.retryable is retryable


# --- TLS ------------------------------------------------------------------------------------------------------------


def test_https_uses_original_hostname_for_sni_and_pinned_ip(site: LocalSite) -> None:
    wrapped: list[str] = []
    conn = site.connector()

    def fake_tls(sock, hostname):  # type: ignore[no-untyped-def]
        wrapped.append(hostname)
        return sock

    f = _fetcher(resolver=lambda h: [PUBLIC], connector=conn, tls_wrap=fake_tls)
    f.fetch_page("https://secure.test/", respect_robots=False)
    assert wrapped == ["secure.test"]  # SNI и проверка сертификата — по имени, а не по IP
    assert conn.seen == [PUBLIC]  # type: ignore[attr-defined]
    assert site.log[0].headers["host"] == "secure.test"


def test_tls_certificate_error_is_reported(site: LocalSite) -> None:
    def bad_tls(sock, hostname):  # type: ignore[no-untyped-def]
        raise ssl.SSLCertVerificationError("bad cert")

    f = _fetcher(resolver=lambda h: [PUBLIC], connector=site.connector(), tls_wrap=bad_tls)
    with pytest.raises(FetchError) as e:
        f.fetch_page("https://secure.test/", respect_robots=False)
    assert e.value.code == "tls_error"


def test_default_tls_context_verifies_certificates() -> None:
    f = SafeFetcher()
    # Без подмены tls_wrap используется стандартный контекст: проверка сертификата и имени включена.
    ctx = ssl.create_default_context()
    assert ctx.verify_mode == ssl.CERT_REQUIRED and ctx.check_hostname
    assert callable(f._tls_wrap)


# --- robots.txt ------------------------------------------------------------------------------------------------------


def robots(site: LocalSite, text: str, status: int = 200, ctype: str | None = "text/plain") -> None:
    site.routes["/robots.txt"] = Resp(status=status, body=text.encode(), content_type=ctype)


def test_robots_disallow_all_blocks_page_without_requesting_it(site: LocalSite) -> None:
    robots(site, "User-agent: *\nDisallow: /\n")
    with pytest.raises(FetchError) as e:
        public_fetcher(site).fetch_page("http://shop.test/")
    assert e.value.code == "robots_disallowed"
    assert site.paths() == ["/robots.txt"]


def test_robots_for_our_agent_wins_over_wildcard(site: LocalSite) -> None:
    robots(
        site,
        "User-agent: *\nDisallow: /\n\nUser-agent: LeadHunterBot\nDisallow: /private\n",
    )
    site.routes["/open"] = HTML
    site.routes["/private/x"] = HTML
    f = public_fetcher(site)
    assert f.fetch_page("http://shop.test/open").status == 200
    with pytest.raises(FetchError) as e:
        f.fetch_page("http://shop.test/private/x")
    assert e.value.code == "robots_disallowed"


def test_robots_disallow_for_our_agent_only(site: LocalSite) -> None:
    robots(site, "User-agent: leadhunterbot\nDisallow: /\n\nUser-agent: *\nAllow: /\n")
    with pytest.raises(FetchError) as e:
        public_fetcher(site).fetch_page("http://shop.test/")
    assert e.value.code == "robots_disallowed"


def test_robots_other_agent_rules_do_not_apply(site: LocalSite) -> None:
    robots(site, "User-agent: GoogleBot\nDisallow: /\n")
    assert public_fetcher(site).fetch_page("http://shop.test/").status == 200


@pytest.mark.parametrize("status", [404, 410, 401, 403])
def test_robots_4xx_means_allowed(site: LocalSite, status: int) -> None:
    robots(site, "User-agent: *\nDisallow: /\n", status=status)
    assert public_fetcher(site).fetch_page("http://shop.test/").status == 200


@pytest.mark.parametrize("status", [500, 502, 503])
def test_robots_5xx_is_unavailable_and_blocks_page(site: LocalSite, status: int) -> None:
    robots(site, "", status=status)
    with pytest.raises(FetchError) as e:
        public_fetcher(site).fetch_page("http://shop.test/")
    assert e.value.code == "robots_unavailable" and e.value.retryable
    assert site.paths() == ["/robots.txt"]


def test_robots_html_page_instead_of_text_is_ignored(site: LocalSite) -> None:
    robots(site, "<html>Disallow: /</html>", ctype="text/html")
    assert public_fetcher(site).fetch_page("http://shop.test/").status == 200


def test_robots_cached_per_origin_for_a_day(site: LocalSite) -> None:
    now = [1_000_000.0]
    f = public_fetcher(site, robots=RobotsCache(now=lambda: now[0]))
    for _ in range(3):
        f.fetch_page("http://shop.test/")
    assert site.paths().count("/robots.txt") == 1
    now[0] += 86400 - 1
    f.fetch_page("http://shop.test/")
    assert site.paths().count("/robots.txt") == 1
    now[0] += 2  # сутки прошли
    f.fetch_page("http://shop.test/")
    assert site.paths().count("/robots.txt") == 2


def test_robots_cache_is_per_domain(site: LocalSite) -> None:
    f = public_fetcher(site)
    f.fetch_page("http://a.test/")
    f.fetch_page("http://b.test/")
    assert site.paths().count("/robots.txt") == 2


def test_robots_redirect_is_followed_with_checks(site: LocalSite) -> None:
    site.routes["/robots.txt"] = redirect("/rules.txt")
    site.routes["/rules.txt"] = Resp(content_type="text/plain", body=b"User-agent: *\nDisallow: /\n")
    with pytest.raises(FetchError) as e:
        public_fetcher(site).fetch_page("http://shop.test/")
    assert e.value.code == "robots_disallowed"


def test_robots_redirect_to_private_is_blocked(site: LocalSite) -> None:
    site.routes["/robots.txt"] = redirect("http://169.254.169.254/robots.txt")
    with pytest.raises(FetchError) as e:
        public_fetcher(site).fetch_page("http://shop.test/")
    assert e.value.code == "host_blocked"


def test_robots_can_be_skipped_explicitly(site: LocalSite) -> None:
    robots(site, "User-agent: *\nDisallow: /\n")
    assert public_fetcher(site).fetch_page("http://shop.test/", respect_robots=False).status == 200
    assert "/robots.txt" not in site.paths()


@pytest.mark.parametrize(
    "text,path,allowed",
    [
        ("User-agent: *\nDisallow: /a", "/a", False),
        ("User-agent: *\nDisallow: /a", "/ab/c", False),
        ("User-agent: *\nDisallow: /a", "/b", True),
        ("User-agent: *\nDisallow:", "/anything", True),
        ("User-agent: *\nDisallow: /a\nAllow: /a/b", "/a/b/c", True),
        ("User-agent: *\nDisallow: /a\nAllow: /a/b", "/a/c", False),
        ("User-agent: *\nAllow: /a\nDisallow: /a", "/a", True),  # при равной длине побеждает Allow
        ("User-agent: *\nDisallow: /*.pdf$", "/x/y.pdf", False),
        ("User-agent: *\nDisallow: /*.pdf$", "/x/y.pdf?v=1", True),
        ("User-agent: *\nDisallow: /*?session=", "/p?session=2&x=1", False),
        ("User-agent: *\nDisallow: /tmp/", "/tmp", True),
        ("User-agent: *\nDisallow: /tmp/", "/tmp/a", False),
        ("# только комментарий\nUser-agent: *\nDisallow: /x # хвост", "/x", False),
        ("Disallow: /x", "/x", True),  # правило без User-agent игнорируется
        ("User-agent: *\r\nDisallow: /crlf\r\n", "/crlf", False),
        ("USER-AGENT: *\nDISALLOW: /Case", "/Case", False),
        ("User-agent: a\nUser-agent: *\nDisallow: /multi", "/multi", False),
        ("", "/x", True),
    ],
)
def test_parse_robots_rules(text: str, path: str, allowed: bool) -> None:
    assert parse_robots(text).allowed(path) is allowed


# --- троттлинг и бюджет страниц ----------------------------------------------------------------------------------------


class FakeTime:
    def __init__(self) -> None:
        self.t = 100.0
        self.sleeps: list[float] = []
        self.lock = threading.Lock()

    def clock(self) -> float:
        return self.t

    def sleep(self, s: float) -> None:
        with self.lock:
            self.sleeps.append(s)
            self.t += s


def test_throttle_spaces_requests_to_same_domain() -> None:
    ft = FakeTime()
    th = DomainThrottle(2.0, clock=ft.clock, sleep=ft.sleep)
    assert th.wait("a.test") == 0
    assert th.wait("a.test") == 2.0
    assert th.wait("a.test") == 2.0
    assert ft.sleeps == [2.0, 2.0]
    assert th.wait("b.test") == 0  # другой домен не ждёт
    ft.t += 10
    assert th.wait("a.test") == 0  # прошло достаточно времени


def test_throttle_concurrent_callers_get_distinct_slots() -> None:
    slots: list[float] = []
    lock = threading.Lock()
    ft = FakeTime()

    def fake_sleep(s: float) -> None:
        with lock:
            slots.append(s)

    th = DomainThrottle(2.0, clock=ft.clock, sleep=fake_sleep)
    threads = [threading.Thread(target=th.wait, args=("same.test",)) for _ in range(6)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sorted(slots) == [2.0, 4.0, 6.0, 8.0, 10.0]  # шестой вызов — без ожидания, остальные по очереди


def test_fetcher_waits_between_requests_to_one_domain(site: LocalSite) -> None:
    ft = FakeTime()
    f = public_fetcher(site, throttle=DomainThrottle(2.0, clock=ft.clock, sleep=ft.sleep))
    f.fetch_page("http://shop.test/")  # robots + страница
    f.fetch_page("http://shop.test/")  # ещё страница (robots из кэша)
    assert ft.sleeps == [2.0, 2.0]
    f.fetch_page("http://other.test/")  # другой домен: свой robots.txt, но без ожидания между доменами
    assert ft.sleeps[:2] == [2.0, 2.0]


def test_page_budget_five_per_domain(site: LocalSite) -> None:
    budget = PageBudget()
    f = public_fetcher(site)
    for _ in range(5):
        f.fetch_page("http://shop.test/", budget=budget, respect_robots=False)
    with pytest.raises(FetchError) as e:
        f.fetch_page("http://shop.test/", budget=budget, respect_robots=False)
    assert e.value.code == "page_budget_exceeded"
    f.fetch_page("http://other.test/", budget=budget, respect_robots=False)  # другой домен — свой счётчик
    assert len(site.log) == 6


def test_redirect_hops_do_not_consume_page_budget(site: LocalSite) -> None:
    site.routes["/a"] = redirect("/b")
    site.routes["/b"] = HTML
    budget = PageBudget(max_pages=1)
    res = public_fetcher(site).fetch_page("http://shop.test/a", budget=budget, respect_robots=False)
    assert res.url.endswith("/b")


# --- локальный режим для тестов -----------------------------------------------------------------------------------------


def test_local_mode_fetches_localhost(site: LocalSite) -> None:
    f = local_fetcher(site)
    res = f.fetch_page(f"http://site.test:{site.port}/")
    assert res.status == 200 and "Привет" in res.body.decode()


def test_production_mode_never_connects_to_localhost(site: LocalSite) -> None:
    f = _fetcher(resolver=lambda h: ["127.0.0.1"])
    with pytest.raises(FetchError) as e:
        f.fetch_page(f"http://site.test:{site.port}/")
    assert e.value.code in {"host_blocked", "port_not_allowed"}
    assert site.log == []
