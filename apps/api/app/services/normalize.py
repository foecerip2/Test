"""Нормализация и разбор данных импорта.

Порт 1-в-1 с эталона `apps/web/src/lib/normalize.ts`. Любое изменение правил делается
в обеих реализациях сразу; паритет проверяют общие фикстуры `tests/fixtures/*.json`
(pytest: `tests/test_parity.py`, vitest: `apps/web/tests/parity.test.ts`).
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Literal
from urllib.parse import unquote

# Границы слов через lookaround: \b в JS не работает с кириллицей, в Python \b другой.
_LEGAL_FORMS = re.compile(
    r"(?<![а-яёa-z0-9])(ооо|оао|зао|пао|ип|ао|llc|ltd)(?![а-яёa-z0-9])", re.IGNORECASE
)
_QUOTES = re.compile("[«»\"'“”„]")
_NON_WORD = re.compile(r"[^a-zа-я0-9]+")
# JS \s включает BOM (﻿), Python — нет.
_WS = r"[\s﻿]"
_WS_RUN = re.compile(f"{_WS}+")
_CITY_PREFIX = re.compile(f"^(г\\.?|город){_WS}+")
_JS_TRIM = "\t\n\v\f\r \xa0                　﻿"

_CITY_ALIAS = {
    "спб": "санкт-петербург",
    "питер": "санкт-петербург",
    "санкт петербург": "санкт-петербург",
    "мск": "москва",
    "екб": "екатеринбург",
    "н.новгород": "нижний новгород",
}


def js_trim(s: str) -> str:
    """String.prototype.trim из JS (набор пробельных символов отличается от str.strip)."""
    return s.strip(_JS_TRIM)


def normalize_name(raw: str) -> str:
    s = raw.lower().replace("ё", "е")
    s = _QUOTES.sub(" ", s)
    s = _LEGAL_FORMS.sub(" ", s)
    s = _NON_WORD.sub(" ", s)
    s = js_trim(s)
    return _WS_RUN.sub(" ", s)


def normalize_city(raw: str) -> str:
    s = js_trim(raw).lower().replace("ё", "е")
    s = _CITY_PREFIX.sub("", s)
    s = _WS_RUN.sub(" ", s)
    return _CITY_ALIAS.get(s, s)


def title_case_city(norm: str) -> str:
    return re.sub(
        f"(^|{_WS}|-)([а-яa-z])",
        lambda m: m.group(1) + m.group(2).upper(),
        norm,
    )


_SCHEME = re.compile(r"^[a-z][a-z0-9+.-]*://")
_HOST_OK = re.compile(r"^[a-z0-9.-]+$")


def _url_host(s: str) -> str | None:
    """Упрощённый WHATWG-разбор: имя хоста http(s)-адреса либо None (аналог new URL(s).hostname)."""
    m = _SCHEME.match(s)
    scheme, rest = (s[: m.end() - 3], s[m.end() :]) if m else ("http", s)
    if scheme not in ("http", "https"):
        return None
    rest = rest.lstrip("/\\")  # для http(s) лишние слеши перед хостом игнорируются
    authority = re.split(r"[/?#\\]", rest, maxsplit=1)[0]
    authority = authority.rpartition("@")[2]  # userinfo
    if authority.startswith("["):
        return None  # IPv6 — не домен
    host, sep, port = authority.partition(":")
    if sep and port and (not port.isascii() or not port.isdigit() or int(port) > 65535):
        return None
    if not host:
        return None
    if "%" in host:
        host = unquote(host)
    if host.isascii():
        return host
    try:
        return ".".join(
            label if label.isascii() else "xn--" + label.encode("punycode").decode("ascii")
            for label in host.split(".")
        )
    except UnicodeError:
        return None


def canonical_domain(raw: str | None) -> str | None:
    """Канонический домен: без схемы, www, пути и порта. None для невалидного значения."""
    if not raw:
        return None
    s = js_trim(raw).lower()
    if not s:
        return None
    s = re.sub(r"[\t\n\r]", "", s)  # URL-парсер выбрасывает табуляцию и переводы строк
    host = _url_host(s)
    if host is None:
        return None
    host = re.sub(r"^www\.", "", host)
    if "." not in host or not _HOST_OK.match(host):
        return None
    return host


def normalize_inn(raw: str | None) -> str | None:
    d = re.sub(r"[^0-9]", "", raw or "")
    return d if len(d) in (10, 12) else None


def parse_csv(text: str) -> list[list[str]]:
    """Разбор CSV (RFC 4180): кавычки, экранирование "", BOM, разделители `;` `,` табуляция."""
    src = text[1:] if text.startswith("﻿") else text
    first_line = re.split(r"\r?\n", src, maxsplit=1)[0]
    counts = {";": 0, ",": 0, "\t": 0}
    in_q = False
    for ch in first_line:
        if ch == '"':
            in_q = not in_q
        elif not in_q and ch in counts:
            counts[ch] += 1
    delim = ";"
    for cand in (",", "\t"):  # при равенстве побеждает первый: `;`, затем `,`, затем табуляция
        if counts[cand] > counts[delim]:
            delim = cand

    rows: list[list[str]] = []
    row: list[str] = []
    cell: list[str] = []
    in_q = False
    i = 0
    n = len(src)
    while i < n:
        ch = src[i]
        if in_q:
            if ch == '"':
                if i + 1 < n and src[i + 1] == '"':
                    cell.append('"')
                    i += 1
                else:
                    in_q = False
            else:
                cell.append(ch)
        elif ch == '"':
            in_q = True
        elif ch == delim:
            row.append("".join(cell))
            cell = []
        elif ch in "\n\r":
            if ch == "\r" and i + 1 < n and src[i + 1] == "\n":
                i += 1
            row.append("".join(cell))
            cell = []
            if any(js_trim(c) != "" for c in row):
                rows.append(row)
            row = []
        else:
            cell.append(ch)
        i += 1
    row.append("".join(cell))
    if any(js_trim(c) != "" for c in row):
        rows.append(row)
    return rows


_CSV_DANGEROUS = re.compile(r"^[=+\-@\t\r]")


def csv_cell(v: str | int | float) -> str:
    """Защита от CSV-инъекций: значения с первым символом = + - @ TAB CR получают апостроф."""
    s = str(v)
    if _CSV_DANGEROUS.match(s):
        s = "'" + s
    return '"' + s.replace('"', '""') + '"'


def to_csv(rows: list[list[str | int | float]]) -> str:
    return "﻿" + "\r\n".join(";".join(csv_cell(c) for c in r) for r in rows)


# ---------------------------------------------------------------------------------------------
# Разбор строк импорта и дедупликация (ТЗ §6): ИНН -> домен+город -> похожее название (кандидат).

DuplicateKind = Literal["exact", "candidate", "in_file"]


@dataclass
class Duplicate:
    kind: DuplicateKind
    of: str


@dataclass
class ImportRow:
    line: int
    name: str
    city: str
    category: str
    website: str | None
    inn: str | None
    issues: list[str] = field(default_factory=list)
    duplicate: Duplicate | None = None


@dataclass
class ExistingCompany:
    name: str
    city: str
    domain: str | None
    inn: str | None = None


_HEADERS: dict[str, list[str]] = {
    "name": ["name", "название", "компания", "наименование", "организация"],
    "city": ["city", "город", "населенный пункт"],
    "category": ["category", "категория", "тип", "вид деятельности"],
    "website": ["website", "site", "сайт", "url", "домен"],
    "inn": ["inn", "инн"],
}

DEFAULT_CATEGORY = "Автосервис"


def _col(header: list[str], key: str) -> int:
    for i, h in enumerate(header):
        if h in _HEADERS[key]:
            return i
    return -1


ExtraIssues = Callable[[str, str, str, str | None], list[str]]


def map_import_rows(
    table: list[list[str]],
    existing: list[ExistingCompany],
    extra_issues: ExtraIssues | None = None,
) -> tuple[list[ImportRow], list[str]]:
    """Возвращает (rows, missing_columns). Строки с ошибками не занимают ключ дедупликации.

    `extra_issues(name, city, category, website)` — серверные проверки поверх эталона (длины,
    недопустимые символы); вызывается до дедупликации, поэтому такие строки тоже не занимают ключ.
    """
    header = [js_trim(h).lower().replace("ё", "е") for h in (table[0] if table else [])]
    col = {k: _col(header, k) for k in ("name", "city", "category", "website", "inn")}
    missing = [("название" if k == "name" else "город") for k in ("name", "city") if col[k] < 0]
    if missing:
        return [], missing

    seen: dict[str, str] = {}
    rows: list[ImportRow] = []
    for i, cells in enumerate(table[1:]):

        def get(c: int, cells: list[str] = cells) -> str:
            return js_trim(cells[c]) if 0 <= c < len(cells) else ""

        name = get(col["name"])
        city_norm = normalize_city(get(col["city"]))
        website_raw = get(col["website"])
        inn_raw = get(col["inn"])
        website = canonical_domain(website_raw)
        inn = normalize_inn(inn_raw)
        issues: list[str] = []
        if not name:
            issues.append("Нет названия")
        if not city_norm:
            issues.append("Нет города")
        if website_raw and not website:
            issues.append("Некорректный сайт")
        if inn_raw and not inn:
            issues.append("Некорректный ИНН")
        category = get(col["category"]) or DEFAULT_CATEGORY
        city_title = title_case_city(city_norm)
        if extra_issues is not None:
            issues.extend(extra_issues(name, city_title, category, website))

        duplicate: Duplicate | None = None
        name_norm = normalize_name(name)
        by_inn = next((e for e in existing if inn and e.inn == inn), None)
        by_domain = next(
            (
                e
                for e in existing
                if website and e.domain == website and normalize_city(e.city) == city_norm
            ),
            None,
        )
        by_name = next(
            (
                e
                for e in existing
                if name_norm
                and normalize_name(e.name) == name_norm
                and normalize_city(e.city) == city_norm
            ),
            None,
        )
        if by_inn:
            duplicate = Duplicate("exact", by_inn.name)
        elif by_domain:
            duplicate = Duplicate("exact", by_domain.name)
        elif by_name:
            duplicate = Duplicate("candidate", by_name.name)
        key = inn or (f"{website}|{city_norm}" if website else f"{name_norm}|{city_norm}")
        if duplicate is None and not issues and key in seen:
            duplicate = Duplicate("in_file", seen[key])
        if not issues and key not in seen:
            seen[key] = name

        rows.append(
            ImportRow(
                line=i + 2,
                name=name,
                city=city_title,
                category=category,
                website=website,
                inn=inn,
                issues=issues,
                duplicate=duplicate,
            )
        )
    return rows, []
