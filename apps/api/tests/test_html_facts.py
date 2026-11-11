"""Извлечение признаков из HTML-фикстур (8+ разных сайтов) и защита от вредного содержимого."""

from __future__ import annotations

import re
import time
from pathlib import Path

import pytest

from app.services.html_facts import (
    EXCERPT_MAX,
    PageFindings,
    clean_text,
    decode_html,
    excerpt_around,
    extract_page,
    mask_pd,
)

SITES = Path(__file__).parent / "fixtures" / "sites"
URL = "https://site.test/"


def load(name: str) -> bytes:
    return (SITES / name).read_bytes()


def page(name: str, url: str = URL) -> PageFindings:
    return extract_page(load(name), url)


def labels(items: list) -> set[str]:  # type: ignore[type-arg]
    return {i.label for i in items}


def all_excerpts(p: PageFindings) -> list[str]:
    groups = (p.services, p.prices, p.hours, p.booking, p.contacts)
    return [e.excerpt for g in groups for e in g] + [p.title, p.text_preview]


# --- хороший сайт ---------------------------------------------------------------------------


def test_good_site_services_prices_hours() -> None:
    p = page("good.html")
    assert p.title.startswith("СТО «Север Авто»")
    assert {"диагностика", "замена масла", "ремонт ходовой", "шиномонтаж"} <= labels(p.services)
    assert "развал-схождение" in labels(p.services)
    assert p.prices and "1 500" in p.prices[0].excerpt
    assert p.hours
    assert not p.has_frames and not p.parse_failed


def test_good_site_booking_form_with_date_is_detected() -> None:
    p = page("good.html")
    kinds = labels(p.booking)
    assert "form" in kinds
    assert any(not e.weak for e in p.booking)


def test_good_site_contacts_present_but_values_not_stored() -> None:
    p = page("good.html")
    assert labels(p.contacts) == {"phone", "email"}
    for text in all_excerpts(p):
        assert not re.search(r"[\w.+-]+@[\w-]+\.", text), text
        assert not re.search(r"\d{5,}", text), text
        assert "sever-avto.example.com" not in text and "900" not in text


def test_good_site_internal_links_exclude_external_and_files() -> None:
    p = page("good.html")
    urls = [u for u, _ in p.links]
    assert "https://site.test/uslugi" in urls
    assert "https://site.test/kontakty" in urls
    assert "https://site.test/zapis" in urls
    assert not any("vk.com" in u for u in urls)
    assert not any(u.endswith(".pdf") for u in urls)


# --- без записи -------------------------------------------------------------------------------


def test_no_booking_site_has_no_booking_signals_even_with_negative_phrase() -> None:
    p = page("no_booking.html")
    assert p.booking == []  # «Онлайн-записи у нас нет» — это не запись
    assert {"ремонт двигателя", "замена масла", "кузовной ремонт"} <= labels(p.services)
    assert p.prices and p.hours
    assert labels(p.contacts) == {"phone", "email"}


# --- виджет записи ------------------------------------------------------------------------------


def test_widget_site_detects_known_booking_domains() -> None:
    p = page("widget.html")
    widgets = [e for e in p.booking if e.label == "widget"]
    hosts = {e.excerpt for e in widgets}
    assert "Виджет записи: b123456.yclients.com" in hosts
    assert "Виджет записи: widget.dikidi.net" in hosts
    assert all(len(e.excerpt) <= EXCERPT_MAX for e in widgets)


@pytest.mark.parametrize(
    "html,expected",
    [
        ('<a href="https://n1.yclients.com/company/1">x</a>', True),
        ('<script src="https://widget.dikidi.ru/w.js"></script>', True),
        ('<script>var u = "https://app.rubitime.ru/x";</script>', True),
        ('<iframe src="https://evil-yclients.com.attacker.example/"></iframe>', False),
        ('<a href="https://notyclients.com/">x</a>', False),
        ('<a href="https://example.com/yclients.com">x</a>', False),
    ],
)
def test_widget_domain_matching_is_strict(html: str, expected: bool) -> None:
    p = extract_page(f"<html><body>{html}</body></html>".encode(), URL)
    assert any(e.label == "widget" for e in p.booking) is expected


# --- пустой, фреймы, мусор ----------------------------------------------------------------------


def test_empty_site_has_no_content() -> None:
    p = page("empty.html")
    assert p.text_len == 0
    assert not (p.services or p.prices or p.hours or p.booking or p.contacts)
    assert not p.has_frames


def test_frameset_site_is_flagged_and_frames_become_links() -> None:
    p = page("frames.html")
    assert p.has_frames is True
    assert p.title == "Автосервис «Рамка»"
    assert ("https://site.test/main.html", "frame") in p.links
    assert ("https://site.test/menu.html", "frame") in p.links


def test_junk_html_does_not_crash_and_yields_nothing() -> None:
    p = page("junk.html")
    assert not p.booking and not p.contacts and not p.services
    assert p.suspicious_instructions is False


def test_binary_garbage_does_not_crash() -> None:
    p = extract_page(bytes(range(256)) * 400, URL)
    assert isinstance(p, PageFindings)
    assert not p.booking and not p.contacts


def test_deeply_nested_html_is_survived() -> None:
    body = ("<div>" * 20000 + "Диагностика" + "</div>" * 20000).encode()
    p = extract_page(body, URL)
    assert isinstance(p, PageFindings)  # без исключения; результат либо найден, либо parse_failed


# --- prompt injection -----------------------------------------------------------------------------


def test_injection_text_does_not_change_extraction() -> None:
    p = page("injection.html")
    assert p.suspicious_instructions is True
    assert (
        p.booking == []
    )  # скрытые блоки (display:none, hidden) не считаются, команды не исполняются
    assert "диагностика" in labels(p.services)
    assert p.hours
    assert labels(p.contacts) == {"phone", "email"}  # адрес из текста — лишь факт наличия
    assert all("attacker" not in e.excerpt for e in p.contacts)


def test_injection_text_is_not_copied_into_excerpts() -> None:
    p = page("injection.html")
    for text in all_excerpts(p):
        low = text.lower()
        assert "ignore" not in low and "игнорируй" not in low
        assert "attacker" not in low and "system prompt" not in low


# --- кодировки -------------------------------------------------------------------------------------


def _cp1251() -> bytes:
    return (SITES / "cp1251.src.html").read_text(encoding="utf-8").encode("cp1251")


def test_cp1251_page_by_meta_charset() -> None:
    raw = _cp1251()
    with pytest.raises(UnicodeDecodeError):
        raw.decode("utf-8")
    p = extract_page(raw, URL)
    assert p.title == "Автосервис «Южный»"
    assert {"диагностика", "шиномонтаж", "замена масла"} <= labels(p.services)
    assert p.prices and p.hours


def test_wrong_header_charset_falls_back() -> None:
    p = extract_page(_cp1251(), URL, charset="utf-8")
    assert p.title == "Автосервис «Южный»"


def test_cp1251_without_any_declaration() -> None:
    html = (
        "<html><body><p>Шиномонтаж и диагностика автомобилей. Работаем ежедневно.</p></body></html>"
    )
    p = extract_page(html.encode("cp1251"), URL)
    assert "шиномонтаж" in labels(p.services)


def test_unknown_header_charset_is_ignored() -> None:
    assert decode_html("Привет".encode(), "no-such-charset") == "Привет"


# --- прочие страницы и вспомогательные функции -----------------------------------------------------


def test_prices_page_all_currency_forms() -> None:
    p = page("prices.html", "https://site.test/uslugi")
    assert p.prices
    assert {"диагностика", "замена масла", "шиномонтаж", "ремонт КПП"} <= labels(p.services)


def test_contacts_page_phrase_booking_and_hours() -> None:
    p = page("contacts.html", "https://site.test/kontakty")
    assert [e.label for e in p.booking] == ["phrase"]
    assert p.hours and labels(p.contacts) == {"phone", "email"}


def test_tel_and_mailto_links_count_as_presence() -> None:
    html = '<p>Свяжитесь с нами</p><a href="tel:+79000000009">позвонить</a><a href="mailto:a@b.example">написать</a>'
    p = extract_page(f"<html><body>{html}</body></html>".encode(), URL)
    assert labels(p.contacts) == {"phone", "email"}
    assert all("79000000009" not in e.excerpt and "a@b" not in e.excerpt for e in p.contacts)


def test_booking_button_is_weak_signal() -> None:
    html = '<html><body><a href="/order">Записаться</a> Работаем для вас каждый день недели.</body></html>'
    p = extract_page(html.encode(), URL)
    assert [e.weak for e in p.booking] == [True]


def test_call_to_book_by_phone_is_not_booking() -> None:
    html = (
        '<html><body><a href="tel:+79000000009">Записаться</a> по телефону, звоните!</body></html>'
    )
    p = extract_page(html.encode(), URL)
    assert p.booking == []


def test_mask_pd_masks_emails_and_phones() -> None:
    masked = mask_pd(
        "Пишите ivan.petrov@example.com или звоните +7 (900) 123-45-67 / 8 900 123 45 67"
    )
    assert "@example" not in masked and "123" not in masked
    assert "•••@•••" in masked


def test_excerpt_is_short_clean_and_masked() -> None:
    text = "x" * 500 + " Диагностика \x00\x07‮ +7 900 111-22-33 " + "y" * 500
    start = text.index("Диагностика")
    ex = excerpt_around(text, start, start + 11, width=400)
    assert len(ex) <= EXCERPT_MAX
    assert "\x00" not in ex and "‮" not in ex
    assert "111-22-33" not in ex


def test_clean_text_removes_control_and_bidi() -> None:
    assert clean_text("a​‮b\x00 \n c") == "a b c"


def test_large_page_is_processed_fast() -> None:
    body = ("<p>" + "Диагностика и ремонт. " * 50 + "</p>\n").encode() * 3000  # ~3 МБ
    started = time.monotonic()
    p = extract_page(body[: 1024 * 1024], URL)
    assert time.monotonic() - started < 10
    assert "диагностика" in labels(p.services)


def test_pathological_phone_like_text_is_not_slow() -> None:
    body = ("<p>" + "8 " * 150000 + "</p>").encode()
    started = time.monotonic()
    extract_page(body, URL)
    assert time.monotonic() - started < 5
