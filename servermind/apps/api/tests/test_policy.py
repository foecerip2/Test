import ipaddress

import pytest

from app.modules.servers import policy
from app.modules.servers.policy import HostPolicyError, check_port, check_username, resolve_target
from tests.conftest import set_env


@pytest.fixture(autouse=True)
def strict(monkeypatch):
    set_env(monkeypatch, allow_private_targets="false")


@pytest.mark.parametrize("host", [
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.254", "192.168.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
    "224.0.0.1", "255.255.255.255", "100.100.100.200", "::1", "fe80::1", "fd00:ec2::254", "::ffff:127.0.0.1",
    "localhost", "db.local", "svc.internal", "x.localhost", "printer.lan", "-bad.example.com", "no_tld", "a..b.com", "",
])
def test_blocks_dangerous_targets(host, monkeypatch):
    # даже если DNS «разрешил» имя в публичный адрес, синтаксис/зарезервированные имена и IP-литералы отклоняются
    monkeypatch.setattr(policy, "_getaddrinfo", lambda h, p, **k: [(2, 1, 6, "", ("93.184.216.34", p))])
    if ":" in host and not host.startswith("::ffff"):
        # IPv6-литералы в MVP не поддерживаются вовсе
        with pytest.raises(HostPolicyError):
            resolve_target(host, 22)
        return
    with pytest.raises(HostPolicyError):
        resolve_target(host, 22)


def test_allows_public_ip_literal_and_returns_it():
    assert resolve_target("8.8.8.8", 22) == ("8.8.8.8", "8.8.8.8")
    assert resolve_target("95.85.247.206", 22) == ("95.85.247.206", "95.85.247.206")


def test_public_hostname_resolves_and_connects_to_pinned_ip(monkeypatch):
    monkeypatch.setattr(policy, "_getaddrinfo", lambda h, p, **k: [(2, 1, 6, "", ("93.184.216.34", p))])
    assert resolve_target("Example.COM.", 22) == ("example.com", "93.184.216.34")


def test_any_private_answer_in_dns_response_blocks_the_target(monkeypatch):
    # «разбавленный» ответ: публичный + приватный адрес → запрещено целиком
    monkeypatch.setattr(policy, "_getaddrinfo", lambda h, p, **k: [
        (2, 1, 6, "", ("93.184.216.34", p)), (2, 1, 6, "", ("10.0.0.5", p))])
    with pytest.raises(HostPolicyError):
        resolve_target("mixed.example.com", 22)


def test_dns_rebinding_each_connection_is_rechecked(monkeypatch):
    """Первый ответ публичный, второй приватный: политика применяется на КАЖДОМ подключении, и подключение идёт по IP."""
    answers = iter([["93.184.216.34"], ["127.0.0.1"]])
    monkeypatch.setattr(policy, "_getaddrinfo", lambda h, p, **k: [(2, 1, 6, "", (a, p)) for a in next(answers)])
    host, ip = resolve_target("rebind.example.com", 22)
    assert ip == "93.184.216.34"  # подключение пойдёт к этому IP, повторного разрешения имени нет
    with pytest.raises(HostPolicyError):
        resolve_target("rebind.example.com", 22)  # следующая проверка (verify) увидит приватный адрес и откажет


def test_ipv6_only_domain_rejected(monkeypatch):
    monkeypatch.setattr(policy, "_getaddrinfo", lambda h, p, **k: [(10, 1, 6, "", ("2606:2800:220:1:248:1893:25c8:1946", p, 0, 0))])
    with pytest.raises(HostPolicyError) as e:
        resolve_target("v6only.example.com", 22)
    assert e.value.code == "ipv6"


def test_dns_failure_is_actionable(monkeypatch):
    def boom(*a, **k):
        raise OSError("nope")

    monkeypatch.setattr(policy, "_getaddrinfo", boom)
    with pytest.raises(HostPolicyError) as e:
        resolve_target("missing.example.com", 22)
    assert e.value.code == "dns"


def test_private_targets_only_with_explicit_flag(monkeypatch):
    set_env(monkeypatch, allow_private_targets="true")
    assert resolve_target("127.0.0.1", 2222) == ("127.0.0.1", "127.0.0.1")


@pytest.mark.parametrize("port,ok", [(22, True), (2222, True), (65535, True), (1024, True), (0, False), (80, False),
                                      (443, False), (1023, False), (65536, False), (-1, False)])
def test_ports(port, ok):
    if ok:
        assert check_port(port) == port
    else:
        with pytest.raises(HostPolicyError):
            check_port(port)


@pytest.mark.parametrize("name,ok", [("servermind", True), ("deploy_1", True), ("root", False), ("Root", False), ("", False),
                                      ("a b", False), ("x" * 40, False), ("-x", False)])
def test_username(name, ok):
    if ok:
        assert check_username(name) == name
    else:
        with pytest.raises(HostPolicyError):
            check_username(name)


def test_is_forbidden_ip_covers_documentation_and_reserved():
    for a in ("203.0.113.5", "198.51.100.1", "192.0.2.1", "240.0.0.1", "198.18.0.1"):
        assert policy.is_forbidden_ip(ipaddress.ip_address(a)), a
    assert not policy.is_forbidden_ip(ipaddress.ip_address("95.85.247.206"))
