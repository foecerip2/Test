"""Паритет с TypeScript-эталоном: общие фикстуры (`tests/fixtures/*.json`).

Ожидаемые значения получены запуском apps/web/src/lib/{normalize,scoring}.ts; те же файлы
проверяет vitest (`apps/web/tests/parity.test.ts`). Расхождение любой реализации — красный тест.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from app.services import normalize as N
from app.services import scoring as S

FIX = Path(__file__).parent / "fixtures"


def load(name: str) -> Any:
    return json.loads((FIX / f"{name}.json").read_text(encoding="utf-8"))


def _params(name: str) -> Any:
    cases = load(name)
    return pytest.mark.parametrize(
        "case", cases, ids=[f"{i}-{repr(c['in'])[:30]}" for i, c in enumerate(cases)]
    )


@_params("normalize_name")
def test_normalize_name(case: dict[str, Any]) -> None:
    assert N.normalize_name(case["in"]) == case["out"]


@_params("normalize_city")
def test_normalize_city(case: dict[str, Any]) -> None:
    assert N.normalize_city(case["in"]) == case["out"]


@_params("title_case_city")
def test_title_case_city(case: dict[str, Any]) -> None:
    assert N.title_case_city(case["in"]) == case["out"]


@_params("canonical_domain")
def test_canonical_domain(case: dict[str, Any]) -> None:
    assert N.canonical_domain(case["in"]) == case["out"]


@_params("normalize_inn")
def test_normalize_inn(case: dict[str, Any]) -> None:
    assert N.normalize_inn(case["in"]) == case["out"]


@_params("parse_csv")
def test_parse_csv(case: dict[str, Any]) -> None:
    assert N.parse_csv(case["in"]) == case["out"]


@_params("csv_cell")
def test_csv_cell(case: dict[str, Any]) -> None:
    assert N.csv_cell(case["in"]) == case["out"]


@_params("to_csv")
def test_to_csv(case: dict[str, Any]) -> None:
    assert N.to_csv(case["in"]) == case["out"]


def _row_dict(r: N.ImportRow) -> dict[str, Any]:
    return {
        "line": r.line,
        "name": r.name,
        "city": r.city,
        "category": r.category,
        "website": r.website,
        "inn": r.inn,
        "issues": r.issues,
        "duplicate": {"kind": r.duplicate.kind, "of": r.duplicate.of} if r.duplicate else None,
    }


@pytest.mark.parametrize("case", load("map_import_rows"), ids=lambda c: c["name"])
def test_map_import_rows(case: dict[str, Any]) -> None:
    existing = [
        N.ExistingCompany(e["name"], e["city"], e.get("domain"), e.get("inn"))
        for e in case["existing"]
    ]
    rows, missing = N.map_import_rows(case["table"], existing)
    assert missing == case["out"]["missingColumns"]
    assert [_row_dict(r) for r in rows] == case["out"]["rows"]


def _score_input(d: dict[str, Any]) -> S.ScoreInput:
    return S.ScoreInput(
        business_type=d["businessType"],
        demand_signals=d["demandSignals"],
        site_works=d["siteWorks"],
        online_booking_detected=d["onlineBookingDetected"],
        has_business_contact=d["hasBusinessContact"],
        is_duplicate=d["isDuplicate"],
        has_refusal=d["hasRefusal"],
    )


_SCORING = load("scoring")


def test_rule_version() -> None:
    assert S.SCORE_RULE_VERSION == _SCORING["rule_version"] == "rules-v1"


@pytest.mark.parametrize("case", _SCORING["cases"], ids=lambda c: c["name"])
def test_score_company(case: dict[str, Any]) -> None:
    score, reasons = S.score_company(_score_input(case["input"]))
    assert score == case["score"]
    assert [dict(r) for r in reasons] == case["reasons"]


def test_weights_sum_to_100() -> None:
    _, reasons = S.score_company(_score_input(_SCORING["cases"][0]["input"]))
    assert [r["max"] for r in reasons] == [25, 20, 15, 15, 15, 10]
    assert sum(r["max"] for r in reasons) == 100


def test_business_type_for_category() -> None:
    assert S.business_type_for_category("Автосервис") == "autoservice"
    assert S.business_type_for_category("СТО") == "autoservice"
    assert S.business_type_for_category("Кузовной ремонт") == "autoservice"
    assert S.business_type_for_category("Стоматология") == "other"
    assert S.business_type_for_category("Кофейня") == "other"
