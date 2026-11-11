"""Извлечение признаков из HTML одной страницы (чистая функция, без сети и БД).

Текст страницы — НЕДОВЕРЕННЫЙ ввод. Здесь он только сопоставляется с фиксированными правилами
(регулярные выражения и списки доменов); никакие «инструкции» из страницы не интерпретируются.
Выдержки (excerpt) очищаются: управляющие символы убираются, e-mail и телефоны маскируются.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from urllib.parse import urljoin, urlsplit

from bs4 import BeautifulSoup
from bs4.element import Tag

EXCERPT_MAX = 200
TEXT_SCAN_LIMIT = 300_000
MAX_LINKS = 300

# Известные системы онлайн-записи (домены виджетов/ссылок). Список можно расширять.
BOOKING_DOMAINS: tuple[str, ...] = (
    "dikidi.net",
    "dikidi.ru",
    "yclients.com",
    "altegio.com",
    "rubitime.ru",
    "easyweek.io",
    "calendly.com",
    "booksy.com",
    "bukza.com",
    "simplybook.me",
    "setmore.com",
)

SERVICE_KEYWORDS: tuple[tuple[str, str], ...] = (
    ("диагностика", r"диагностик"),
    ("шиномонтаж", r"шиномонтаж"),
    ("развал-схождение", r"развал[\s-]*схожден"),
    ("замена масла", r"замен\w*\s+масл"),
    ("техобслуживание", r"тех\w*\s*обслуживани|плановое\s+то\b"),
    ("ремонт двигателя", r"ремонт\w*\s+(двигател|двс)"),
    ("ремонт ходовой", r"ремонт\w*\s+(ходов|подвеск)"),
    ("ремонт КПП", r"ремонт\w*\s+(акпп|кпп|коробк)"),
    ("кузовной ремонт", r"кузовн\w+\s+ремонт|покраск|рихтовк"),
    ("автоэлектрика", r"автоэлектр|электрик\w*\s+авто"),
    ("тормозная система", r"тормоз"),
    ("кондиционеры", r"кондиционер"),
    ("детейлинг", r"детейлинг|полировк|химчистк"),
    ("мойка", r"автомойк|мойк"),
)

_PRICE = re.compile(r"\d[\d\s]{0,7}\s*(?:₽|руб(?:\.|лей|ля|)\b|р\.)", re.IGNORECASE)
_HOURS = re.compile(
    r"(?:режим|график)\s+работы"
    r"|\b(?:пн|вт|ср|чт|пт|сб|вс)\.?\s*[-–—]\s*(?:пн|вт|ср|чт|пт|сб|вс)\b"
    r"|\b\d{1,2}[:.]\d{2}\s*[-–—]\s*\d{1,2}[:.]\d{2}"
    r"|круглосуточно|без\s+выходных|ежедневно\s+с\b",
    re.IGNORECASE,
)
_BOOKING_PHRASE = re.compile(
    r"онлайн[\s-]*запис|запис\w*[^.!?\n]{0,25}онлайн|on-?line\s+booking|book\s+online",
    re.IGNORECASE,
)
_BOOKING_NEGATION = re.compile(r"(?:нет|без|не\s+\w+|отсутствует)\s*$", re.IGNORECASE)
_BOOKING_NEGATION_AFTER = re.compile(
    r"^[^.!?]{0,20}\b(?:нет|отсутств\w*|недоступн\w*|не\s+предусмотрен\w*)", re.IGNORECASE
)
_BOOKING_BUTTON = re.compile(r"^(?:записаться|записаться\s+на\s+\w+|запись\s+на\s+\w+)\b", re.I)
_BOOKING_FORM_HINT = re.compile(r"zapis|record|booking|appointment|запис", re.IGNORECASE)

_EMAIL = re.compile(r"[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63}){1,5}")
_PHONE = re.compile(r"(?:\+7|\b8)[\s(.-]{0,2}\d{3}[\s).-]{0,2}\d{3}[\s.-]?\d{2}[\s.-]?\d{2}\b")

_INJECTION = re.compile(
    r"ignore\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above)"
    r"|disregard\s+[^.]{0,40}instruction"
    r"|system\s+prompt|developer\s+message"
    r"|you\s+are\s+(?:now\s+)?(?:an?\s+)?(?:ai|assistant|chatgpt|language\s+model)"
    r"|игнорируй|забудь\s+(?:все\s+)?(?:предыдущ|инструкц)|системн\w+\s+промпт"
    r"|(?:выставь|поставь|set)\s+(?:оценк|score|рейтинг)"
    r"|отправь\s+(?:письмо|письма|email|сообщени)|send\s+(?:an?\s+)?(?:e-?mail|message)",
    re.IGNORECASE,
)

_SKIP_EXT = re.compile(
    r"\.(?:pdf|jpe?g|png|gif|webp|svg|ico|zip|rar|7z|docx?|xlsx?|pptx?|mp[34]|avi|css|js|xml)$",
    re.IGNORECASE,
)
_CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f-\x9f​-‏‪-‮⁦-⁩﻿]")


@dataclass
class Evidence:
    label: str
    excerpt: str
    weak: bool = False


@dataclass
class PageFindings:
    url: str
    title: str = ""
    text_len: int = 0
    text_preview: str = ""
    has_frames: bool = False
    services: list[Evidence] = field(default_factory=list)
    prices: list[Evidence] = field(default_factory=list)
    hours: list[Evidence] = field(default_factory=list)
    booking: list[Evidence] = field(default_factory=list)
    contacts: list[Evidence] = field(default_factory=list)  # label: "phone" | "email"
    links: list[tuple[str, str]] = field(default_factory=list)  # (абсолютный URL, текст ссылки)
    suspicious_instructions: bool = False
    parse_failed: bool = False


# ---------------------------------------------------------------------------------------------
# Декодирование и очистка.

_META_CHARSET = re.compile(rb"""<meta[^>]+charset\s*=\s*["']?\s*([A-Za-z0-9_.:-]+)""", re.I)


def decode_html(body: bytes, header_charset: str | None = None) -> str:
    """Байты → текст. Порядок: charset заголовка, <meta>, UTF-8, cp1251, latin-1."""
    candidates: list[str] = []
    if header_charset:
        candidates.append(header_charset)
    m = _META_CHARSET.search(body[:8192])
    if m:
        candidates.append(m.group(1).decode("ascii", "ignore"))
    candidates.append("utf-8")
    for enc in candidates:
        try:
            return body.decode(enc.strip())
        except (UnicodeDecodeError, LookupError):
            continue
    # Почти-UTF-8 (например, обрезанный на середине символа) — не кодировка cp1251.
    loose = body.decode("utf-8", errors="replace")
    if loose.count("\ufffd") <= max(3, len(loose) // 200):
        return loose
    try:
        return body.decode("cp1251")
    except UnicodeDecodeError:
        return body.decode("cp1251", errors="replace")


def clean_text(value: str) -> str:
    return re.sub(r"\s+", " ", _CONTROL.sub(" ", value)).strip()


def mask_pd(value: str) -> str:
    """Маскирует e-mail и телефоны (персональные данные не попадают в факты и логи)."""

    def phone(m: re.Match[str]) -> str:
        return re.sub(r"\d", "•", m.group(0))

    return _PHONE.sub(phone, _EMAIL.sub("•••@•••", value))


def _fold(text: str) -> str:
    folded = text.lower().replace("ё", "е")
    return folded if len(folded) == len(text) else text


def excerpt_around(text: str, start: int, end: int, *, width: int = 60) -> str:
    """Выдержка вокруг совпадения: ≤200 символов, без ПД и управляющих символов."""
    lo, hi = max(0, start - width), min(len(text), end + width)
    chunk = mask_pd(clean_text(text[lo:hi]))
    if _INJECTION.search(
        chunk
    ):  # вредные «инструкции» в выдержку не кладём — только само совпадение
        chunk = mask_pd(clean_text(text[start:end]))
    return chunk[:EXCERPT_MAX]


# ---------------------------------------------------------------------------------------------


def _preview(text: str) -> str:
    """Начало видимого текста для выдержки о «живом» сайте (≤150 символов, без ПД)."""
    snippet = mask_pd(text[:150])
    return "" if _INJECTION.search(snippet) else snippet


def _host_matches(host: str, domain: str) -> bool:
    return host == domain or host.endswith("." + domain)


def _widget_host(value: str) -> str | None:
    try:
        host = (urlsplit(value.strip()).hostname or "").lower()
    except ValueError:
        return None
    for d in BOOKING_DOMAINS:
        if _host_matches(host, d):
            return host
    return None


_URL_IN_TEXT = re.compile(r"https?://([a-z0-9.-]+)", re.IGNORECASE)


def _is_hidden(tag: Tag) -> bool:
    if tag.has_attr("hidden") or tag.get("aria-hidden") == "true":
        return True
    style = str(tag.get("style") or "").replace(" ", "").lower()
    return "display:none" in style or "visibility:hidden" in style


def _same_site(host: str, base_host: str) -> bool:
    def norm(h: str) -> str:
        return h.lower().removeprefix("www.")

    return norm(host) == norm(base_host)


def extract_page(body: bytes, url: str, charset: str | None = None) -> PageFindings:
    """Признаки одной страницы. Никогда не бросает исключений из-за содержимого страницы."""
    out = PageFindings(url=url)
    try:
        _extract(body, url, charset, out)
    except RecursionError:
        out.parse_failed = True
    except (ValueError, TypeError, AttributeError):
        out.parse_failed = True
    return out


def _extract(body: bytes, url: str, charset: str | None, out: PageFindings) -> None:
    html = decode_html(body, charset).replace("\x00", "")
    soup = BeautifulSoup(html, "html.parser")
    base_host = urlsplit(url).hostname or ""

    title_tag = soup.find("title")
    if title_tag is not None:
        out.title = mask_pd(clean_text(title_tag.get_text(" ")))[:150]

    # 1) Виджеты записи и ссылки — до удаления скриптов (скрипты не исполняются, только читаются).
    seen_widgets: set[str] = set()
    for tag in soup.find_all(["iframe", "script", "a", "form", "link", "frame"]):
        for attr in ("src", "href", "action", "data-src"):
            val = tag.get(attr)
            if isinstance(val, str):
                host = _widget_host(val)
                if host and host not in seen_widgets:
                    seen_widgets.add(host)
                    out.booking.append(Evidence("widget", f"Виджет записи: {host}"))
        if tag.name == "script" and not tag.get("src"):
            for wm in _URL_IN_TEXT.finditer(tag.get_text()[:200_000]):
                host = _widget_host(wm.group(0))
                if host and host not in seen_widgets:
                    seen_widgets.add(host)
                    out.booking.append(Evidence("widget", f"Виджет записи: {host}"))

    # 2) Ссылки на внутренние страницы и фреймы.
    for tag in soup.find_all(["a", "frame", "iframe"]):
        raw = tag.get("href") if tag.name == "a" else tag.get("src")
        if not isinstance(raw, str) or len(out.links) >= MAX_LINKS:
            continue
        raw = raw.strip()
        if not raw or raw.startswith(("#", "mailto:", "tel:", "javascript:", "data:")):
            continue
        try:
            absolute = urljoin(url, raw).split("#", 1)[0]
            parts = urlsplit(absolute)
        except ValueError:
            continue
        if parts.scheme not in ("http", "https") or not parts.hostname:
            continue
        if not _same_site(parts.hostname, base_host) or _SKIP_EXT.search(parts.path):
            continue
        text = clean_text(tag.get_text(" "))[:80] if tag.name == "a" else "frame"
        out.links.append((absolute, text))

    # 3) Контакты по ссылкам tel:/mailto: (сами значения не сохраняются).
    for tag in soup.find_all("a", href=True):
        href = str(tag.get("href")).strip().lower()
        if href.startswith("tel:"):
            out.contacts.append(Evidence("phone", "Ссылка tel: на странице"))
            break
    for tag in soup.find_all("a", href=True):
        if str(tag.get("href")).strip().lower().startswith("mailto:"):
            out.contacts.append(Evidence("email", "Ссылка mailto: на странице"))
            break

    # 4) Кнопки и формы записи.
    for tag in soup.find_all(["a", "button", "input"]):
        if tag.name == "input" and str(tag.get("type", "")).lower() not in ("submit", "button"):
            continue
        label = clean_text(str(tag.get("value", "")) if tag.name == "input" else tag.get_text(" "))
        if label and _BOOKING_BUTTON.match(label):
            href = str(tag.get("href", "")).strip().lower() if tag.name == "a" else "-"
            if href.startswith(("tel:", "mailto:")):
                continue
            out.booking.append(Evidence("button", mask_pd(label)[:EXCERPT_MAX], weak=True))
            break
    for form in soup.find_all("form"):
        controls = form.find_all(["input", "select", "textarea"])
        if not controls:
            continue
        has_slot = any(
            str(c.get("type", "")).lower() in ("date", "time", "datetime-local") for c in controls
        )
        hint = " ".join(str(form.get(a, "")) for a in ("id", "class", "action", "name"))
        submit = " ".join(
            clean_text(b.get_text(" ")) or str(b.get("value", ""))
            for b in form.find_all(["button", "input"])
            if b.name == "button" or str(b.get("type", "")).lower() == "submit"
        )
        if has_slot or (_BOOKING_FORM_HINT.search(hint) and "запис" in submit.lower()):
            out.booking.append(Evidence("form", "Форма записи с выбором даты или времени"))
            break

    # 5) Видимый текст: скрытое, скрипты и стили не считаются.
    has_frameset = soup.find("frameset") is not None
    frame_count = len(soup.find_all(["iframe", "frame"]))
    for tag in soup.find_all(["script", "style", "noscript", "template", "svg", "head"]):
        tag.decompose()
    for tag in soup.find_all(True):
        if isinstance(tag, Tag) and _is_hidden(tag):
            tag.decompose()
    text = clean_text(soup.get_text(" "))[:TEXT_SCAN_LIMIT]
    out.text_len = len(text)
    out.text_preview = _preview(text)
    out.has_frames = has_frameset or (frame_count > 0 and out.text_len < 40)
    out.suspicious_instructions = bool(_INJECTION.search(text))
    low = _fold(text)

    for label, pattern in SERVICE_KEYWORDS:
        m = re.search(pattern, low)
        if m:
            out.services.append(Evidence(label, excerpt_around(text, m.start(), m.end())))
    m = _PRICE.search(low)
    if m:
        out.prices.append(Evidence("price", excerpt_around(text, m.start(), m.end())))
    m = _HOURS.search(low)
    if m:
        out.hours.append(Evidence("hours", excerpt_around(text, m.start(), m.end())))

    for bm in _BOOKING_PHRASE.finditer(low):
        if _BOOKING_NEGATION.search(low[max(0, bm.start() - 20) : bm.start()]):
            continue
        if _BOOKING_NEGATION_AFTER.search(low[bm.end() : bm.end() + 30]):
            continue
        out.booking.append(Evidence("phrase", excerpt_around(text, bm.start(), bm.end())))
        break

    if not any(c.label == "email" for c in out.contacts):
        m = _EMAIL.search(text)
        if m:
            out.contacts.append(
                Evidence("email", excerpt_around(text, m.start(), m.end(), width=30))
            )
    if not any(c.label == "phone" for c in out.contacts):
        m = _PHONE.search(text)
        if m:
            out.contacts.append(
                Evidence("phone", excerpt_around(text, m.start(), m.end(), width=30))
            )
