"""Политика целевых адресов (SSRF): синтаксис имени, запрет приватных/loopback/link-local/metadata/CGNAT/reserved,
проверка ВСЕХ адресов DNS-ответа и подключение по уже проверенному IP (закрепление — защита от DNS rebinding)."""

from __future__ import annotations

import ipaddress
import re
import socket

from app.core.config import get_settings

_HOSTNAME_RE = re.compile(r"^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$", re.I)
_USERNAME_RE = re.compile(r"^[a-z_][a-z0-9_-]{0,31}$")
_BLOCKED_NAMES = ("localhost",)
_BLOCKED_SUFFIXES = (".local", ".internal", ".localhost", ".lan", ".home.arpa")
METADATA_IPS = {ipaddress.ip_address("169.254.169.254"), ipaddress.ip_address("100.100.100.200"), ipaddress.ip_address("fd00:ec2::254")}

# Подменяется в тестах (DNS rebinding и т.п.)
_getaddrinfo = socket.getaddrinfo


class HostPolicyError(Exception):
    def __init__(self, message: str, code: str = "host_policy") -> None:
        super().__init__(message)
        self.message = message
        self.code = code


def check_username(username: str, *, accept_root_risk: bool = False) -> str:
    """Вход под root разрешён ТОЛЬКО как осознанный выбор владельца сервера (accept_root_risk): ключ ServerMind получает полный доступ.
    По умолчанию рекомендуется отдельный пользователь. Что именно выполняет ServerMind, от пользователя не зависит (фиксированный список)."""
    u = username.strip()
    if u == "root" and not accept_root_risk:
        raise HostPolicyError("Вход под root даёт ключу ServerMind полный доступ к серверу. Подтвердите риск явным согласием "
                              "или используйте отдельного пользователя (рекомендуется).", "root_ack_required")
    if not _USERNAME_RE.fullmatch(u):
        raise HostPolicyError("Имя пользователя: строчные латинские буквы, цифры, _ и -.", "username")
    return u


def check_port(port: int) -> int:
    if not isinstance(port, int) or isinstance(port, bool) or not (1 <= port <= 65535):
        raise HostPolicyError("Порт — число от 1 до 65535.", "port")
    if port != 22 and port < 1024:
        raise HostPolicyError("Привилегированные порты, кроме 22, запрещены политикой безопасности.", "port")
    return port


def is_forbidden_ip(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    if ip in METADATA_IPS:
        return True
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        return is_forbidden_ip(ip.ipv4_mapped)
    return (not ip.is_global) or ip.is_multicast or ip.is_unspecified or ip.is_loopback or ip.is_link_local


def normalize_host(raw: str) -> str:
    host = raw.strip().lower().rstrip(".")
    if not host:
        raise HostPolicyError("Укажите IP-адрес или доменное имя.")
    try:
        ipaddress.ip_address(host)
        return host
    except ValueError:
        pass
    if host in _BLOCKED_NAMES or host.endswith(_BLOCKED_SUFFIXES):
        raise HostPolicyError("Локальные имена запрещены политикой безопасности.")
    if not _HOSTNAME_RE.fullmatch(host):
        raise HostPolicyError("Некорректное доменное имя или IP-адрес.")
    return host


def resolve_target(raw_host: str, port: int) -> tuple[str, str]:
    """Возвращает (нормализованный host, IP для подключения). Подключаться нужно к IP, а не к имени."""
    host = normalize_host(raw_host)
    check_port(port)
    allow_private = get_settings().allow_private_targets
    try:
        literal = ipaddress.ip_address(host)
        addrs = [literal]
    except ValueError:
        try:
            infos = _getaddrinfo(host, port, type=socket.SOCK_STREAM)
        except OSError:
            raise HostPolicyError("Не удалось разрешить DNS-имя. Проверьте запись A/AAAA.", "dns") from None
        addrs = []
        for info in infos:
            try:
                addrs.append(ipaddress.ip_address(info[4][0]))
            except ValueError:
                continue
    if not addrs:
        raise HostPolicyError("Не удалось разрешить DNS-имя. Проверьте запись A/AAAA.", "dns")
    if not allow_private:
        for a in addrs:
            if is_forbidden_ip(a):
                raise HostPolicyError("Адрес указывает на приватную, loopback или служебную сеть — это запрещено политикой безопасности.")
    v4 = [a for a in addrs if a.version == 4]
    if not v4:
        raise HostPolicyError("IPv6 в MVP не поддерживается: у домена нет адреса IPv4.", "ipv6")
    return host, str(v4[0])
