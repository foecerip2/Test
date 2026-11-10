import datetime as dt

from app.modules.policy.plan_hash import canonicalize, compute_hash, format_expires, hash_payload

# Общий вектор с apps/web/lib/plan.test.ts: хеш, который видит человек в браузере, обязан совпадать с серверным.
VECTOR_A = "4f125d2be9ffb9c848b0196481587c57beec87a705bc047e70b4ed59e485c331"
VECTOR_B = "1833a6c2343477a0bb2f27a0709453d54bc46b9c9befcb1983f817be8b48fbcf"

STEPS_A = [
    {"tool": "service.restart", "params": {"unit": "nginx"}, "risk": "R2", "enabled": True},
    {"tool": "http.healthcheck", "params": {"url": "http://127.0.0.1:8080/healthz", "expect_status": 200, "timeout_s": 10},
     "risk": "R1", "enabled": False},
]


def test_cross_language_vector_a():
    assert compute_hash("11111111-1111-4111-8111-111111111111", "00000000-0000-4000-8000-000000000002", 3, "2026-11-10T04:30:00Z", STEPS_A) == VECTOR_A


def test_cross_language_vector_b_unicode_nested_null_bool():
    steps = [{"tool": "x.test", "params": {"k": "Привет", "n": [1, True, None], "z": {"b": 2, "a": 1}}, "risk": "R0", "enabled": True}]
    assert compute_hash("p", "s", 1, "2026-11-10T04:30:00Z", steps) == VECTOR_B
    assert canonicalize(hash_payload("p", "s", 1, "2026-11-10T04:30:00Z", steps)).startswith('{"expires_at":"2026-11-10T04:30:00Z","plan_id":"p"')


def test_hash_changes_on_any_security_relevant_field():
    base = compute_hash("p", "s", 1, "2026-11-10T04:30:00Z", STEPS_A)
    assert compute_hash("p2", "s", 1, "2026-11-10T04:30:00Z", STEPS_A) != base
    assert compute_hash("p", "s2", 1, "2026-11-10T04:30:00Z", STEPS_A) != base
    assert compute_hash("p", "s", 2, "2026-11-10T04:30:00Z", STEPS_A) != base
    assert compute_hash("p", "s", 1, "2026-11-10T04:30:01Z", STEPS_A) != base
    changed = [dict(STEPS_A[0], params={"unit": "caddy"}), STEPS_A[1]]
    assert compute_hash("p", "s", 1, "2026-11-10T04:30:00Z", changed) != base
    enabled = [STEPS_A[0], dict(STEPS_A[1], enabled=True)]
    assert compute_hash("p", "s", 1, "2026-11-10T04:30:00Z", enabled) != base


def test_hash_ignores_human_readable_fields():
    a = [dict(STEPS_A[0], title="A", rollback="x")]
    b = [dict(STEPS_A[0], title="B", rollback="y")]
    assert compute_hash("p", "s", 1, "e", a) == compute_hash("p", "s", 1, "e", b)


def test_expires_format_is_utc_seconds():
    assert format_expires(dt.datetime(2026, 11, 10, 7, 30, 0, 999, tzinfo=dt.timezone(dt.timedelta(hours=3)))) == "2026-11-10T04:30:00Z"
