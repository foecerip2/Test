"""Операции исполнителя. ADR 0004: на сервере исполняется только заранее установленная владельцем обёртка
`servermind-op <операция> <параметры-JSON>`; произвольной команды нет. Здесь формируется ТОЛЬКО текст вызова для показа
человеку (режим «репетиция»): ничего не отправляется на сервер."""

from __future__ import annotations

import shlex
from typing import Any

from pydantic import ValidationError

from app.modules.policy.catalog import CATALOG
from app.modules.policy.plan_hash import canonicalize

WRAPPER = "/usr/local/sbin/servermind-op"

# Решение владельца (ADR 0004, п. 4): первая версия — только эти операции. Остальные из каталога блокируются.
SUPPORTED: frozenset[str] = frozenset({"service.restart", "http.healthcheck"})


class OpError(Exception):
    pass


def render(tool: str, params: dict[str, Any]) -> str:
    """Текст вызова обёртки. Параметры заново проходят схему каталога (extra=forbid), затем канонизируются и экранируются."""
    spec = CATALOG.get(tool)
    if spec is None or not spec.enabled:
        raise OpError(f"операция «{tool[:48]}» не входит в каталог")
    try:
        clean = spec.params_model(**params).model_dump()
    except ValidationError:
        raise OpError("параметры не прошли схему каталога") from None
    return f"sudo -n {WRAPPER} {tool} {shlex.quote(canonicalize(clean))}"
