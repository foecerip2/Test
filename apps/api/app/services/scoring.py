"""Rule-based скоринг 0–100 (ТЗ §9). Веса: 25/20/15/15/15/10. Каждое решение объяснимо.

Порт 1-в-1 с эталона `apps/web/src/lib/scoring.ts` (паритет — `tests/fixtures/scoring.json`).
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from typing import Literal, TypedDict

SCORE_RULE_VERSION = "rules-v1"

BusinessType = Literal["autoservice", "adjacent", "other"]


@dataclass
class ScoreInput:
    business_type: BusinessType
    demand_signals: float  # число найденных признаков спроса (услуги, цены, расписание…)
    site_works: bool
    #: True — онлайн-запись обнаружена, False — не обнаружена, None — не проверялось
    online_booking_detected: bool | None
    has_business_contact: bool
    is_duplicate: bool
    has_refusal: bool


class ScoreReason(TypedDict):
    rule: str
    label: str
    points: int
    max: int
    note: str


def _js_round(x: float) -> int:
    """Math.round из JS: .5 округляется вверх (Python round — к чётному)."""
    return math.floor(x + 0.5)


def _js_num(x: float) -> str:
    """Строковое представление числа как в JS (3 -> "3", 3.5 -> "3.5")."""
    return str(int(x)) if float(x).is_integer() else repr(x)


def score_company(i: ScoreInput) -> tuple[int, list[ScoreReason]]:
    bt = i.business_type
    if i.online_booking_detected is None:
        booking_note = "Не проверялось — баллы не начислены"
    elif i.online_booking_detected:
        booking_note = "Онлайн-запись обнаружена"
    else:
        booking_note = "Не обнаружена (это не доказательство её отсутствия)"
    if i.has_refusal:
        clean_note = "Есть отказ"
    elif i.is_duplicate:
        clean_note = "Помечен как дубликат"
    else:
        clean_note = "Чисто"
    reasons: list[ScoreReason] = [
        {
            "rule": "business_type",
            "label": "Тип бизнеса",
            "max": 25,
            "points": 25 if bt == "autoservice" else 12 if bt == "adjacent" else 0,
            "note": (
                "Автосервис / СТО"
                if bt == "autoservice"
                else "Смежная категория"
                if bt == "adjacent"
                else "Не целевая категория"
            ),
        },
        {
            "rule": "demand",
            "label": "Признаки спроса",
            "max": 20,
            "points": min(20, max(0, _js_round(i.demand_signals * 7))),
            "note": f"Найдено признаков: {_js_num(i.demand_signals)}",
        },
        {
            "rule": "site",
            "label": "Работающий сайт",
            "max": 15,
            "points": 15 if i.site_works else 0,
            "note": "Сайт доступен" if i.site_works else "Сайт не найден или недоступен",
        },
        {
            "rule": "booking",
            "label": "Онлайн-запись не обнаружена",
            "max": 15,
            "points": 15 if i.site_works and i.online_booking_detected is False else 0,
            "note": booking_note,
        },
        {
            "rule": "contact",
            "label": "Разрешённый контакт",
            "max": 15,
            "points": 15 if i.has_business_contact else 0,
            "note": "Есть публичный бизнес-контакт"
            if i.has_business_contact
            else "Контакт не найден",
        },
        {
            "rule": "clean",
            "label": "Нет дубликата и отказа",
            "max": 10,
            "points": 10 if not i.is_duplicate and not i.has_refusal else 0,
            "note": clean_note,
        },
    ]
    score = max(0, min(100, sum(r["points"] for r in reasons)))
    return score, reasons


# Границы слов через lookaround (\b не работает с кириллицей). Только категория из файла импорта.
_AUTOSERVICE = re.compile(
    r"(автосервис|(?<![а-яёa-z0-9])сто(?![а-яёa-z0-9])|ремонт|шиномонтаж|кузов|детейлинг|автомойк)",
    re.IGNORECASE,
)


def business_type_for_category(category: str) -> BusinessType:
    return "autoservice" if _AUTOSERVICE.search(category) else "other"


def import_score_input(
    category: str, *, duplicate_candidate: bool = False, refused: bool = False
) -> ScoreInput:
    """Вход скоринга для импортированной компании: ничего не проверялось."""
    return ScoreInput(
        business_type=business_type_for_category(category),
        demand_signals=0,
        site_works=False,
        online_booking_detected=None,
        has_business_contact=False,
        is_duplicate=duplicate_candidate,
        has_refusal=refused,
    )
