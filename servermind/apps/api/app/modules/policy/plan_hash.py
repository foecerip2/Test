"""Канонический хеш плана. ДОЛЖЕН совпадать с веб-реализацией (apps/web/lib/plan.ts: canonicalize/planHashPayload);
контракт закреплён общим тестовым вектором в tests/test_plan_hash.py и apps/web/lib/plan.test.ts.

Формат: SHA-256 от канонического JSON {plan_id, server_id, revision, expires_at, steps[{tool, params, risk}]} —
ключи отсортированы, без пробелов, UTF-8; в steps только ВКЛЮЧЁННЫЕ шаги в порядке плана;
expires_at — строка вида 2026-11-10T04:30:00Z (секундная точность)."""

from __future__ import annotations

import datetime as dt
import hashlib
import json
from typing import Any


def canonicalize(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True, allow_nan=False)


def format_expires(t: dt.datetime) -> str:
    return t.astimezone(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def hash_payload(plan_id: str, server_id: str, revision: int, expires_at: str, steps: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "plan_id": plan_id,
        "server_id": server_id,
        "revision": revision,
        "expires_at": expires_at,
        "steps": [{"tool": s["tool"], "params": s["params"], "risk": s["risk"]} for s in steps if s.get("enabled", True)],
    }


def compute_hash(plan_id: str, server_id: str, revision: int, expires_at: str, steps: list[dict[str, Any]]) -> str:
    payload = hash_payload(plan_id, server_id, revision, expires_at, steps)
    return hashlib.sha256(canonicalize(payload).encode("utf-8")).hexdigest()
