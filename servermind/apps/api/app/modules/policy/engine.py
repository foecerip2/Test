"""Policy engine: единственная точка, через которую предложение модели может стать планом.
Модель НЕ является источником прав: всё проверяется схемой, каталогом, состоянием сервера и ролью пользователя."""

from __future__ import annotations

from typing import Any

from pydantic import ValidationError

from app.core.config import Settings
from app.core.security import redact
from app.db.models import Server, ServerMetricSample
from app.modules.policy.catalog import CATALOG, MAX_ALLOWED_RISK, risk_rank

MAX_STEPS = 8
DISK_BLOCK_PERCENT = 90


class PolicyViolation(Exception):
    def __init__(self, reasons: list[str]) -> None:
        super().__init__("; ".join(reasons))
        self.reasons = reasons


def _safe(name: object) -> str:
    return redact(str(name))[:64]


def _services(sample: ServerMetricSample | None) -> dict[str, str]:
    return {s["name"]: s["state"] for s in (sample.services if sample else [])}


def validate_proposal(
    proposals: Any, *, server: Server, latest: ServerMetricSample | None, role: str, settings: Settings,
) -> list[dict[str, Any]]:
    """Возвращает нормализованные шаги плана или бросает PolicyViolation со всеми причинами отказа."""
    errors: list[str] = []
    if role not in ("owner", "operator"):
        raise PolicyViolation(["Ваша роль не позволяет создавать планы изменений."])
    if not isinstance(proposals, list) or not (1 <= len(proposals) <= MAX_STEPS):
        raise PolicyViolation([f"План должен содержать от 1 до {MAX_STEPS} шагов."])

    steps: list[dict[str, Any]] = []
    seen: set[str] = set()
    services = _services(latest)
    disk_pct = (latest.disk_used_gb / latest.disk_total_gb * 100) if latest and latest.disk_used_gb is not None and latest.disk_total_gb else None
    has_install = False

    for i, raw in enumerate(proposals, start=1):
        if not isinstance(raw, dict) or set(raw) != {"tool", "params"} or not isinstance(raw.get("params"), dict):
            errors.append(f"Шаг {i}: ожидается объект с полями tool и params.")
            continue
        name = raw["tool"]
        spec = CATALOG.get(name) if isinstance(name, str) else None
        if spec is None or not spec.enabled:
            errors.append(f"Шаг {i}: операция «{_safe(name)}» не входит в список одобренных.")
            continue
        if risk_rank(spec.risk) > risk_rank(MAX_ALLOWED_RISK):
            errors.append(f"Шаг {i}: уровень риска {spec.risk} запрещён в MVP.")
            continue
        try:
            params = spec.params_model(**raw["params"]).model_dump()
        except ValidationError as e:
            fields = sorted({".".join(str(p) for p in err["loc"]) or "params" for err in e.errors()})
            errors.append(f"Шаг {i} ({name}): некорректные параметры: {', '.join(fields)}.")
            continue

        if spec.mutating:
            if server.status != "online" or latest is None:
                errors.append(f"Шаг {i} ({name}): сервер недоступен или нет данных о его состоянии.")
            if name == "service.restart":
                unit = params["unit"]
                if unit not in settings.managed_services:
                    errors.append(f"Шаг {i}: служба «{unit}» не входит в список управляемых.")
                elif unit not in services:
                    errors.append(f"Шаг {i}: служба «{unit}» не найдена на сервере.")
            if name in ("docker.install", "app.deploy_compose"):
                if disk_pct is None:
                    errors.append(f"Шаг {i} ({name}): нет данных о диске.")
                elif disk_pct >= DISK_BLOCK_PERCENT:
                    errors.append(f"Шаг {i} ({name}): диск заполнен на {disk_pct:.0f}% — ресурсоёмкие операции заблокированы (порог {DISK_BLOCK_PERCENT}%).")
            if name == "app.deploy_compose":
                if not any(params["image"].startswith(p) for p in settings.allowed_image_prefixes):
                    errors.append(f"Шаг {i}: образ не из разрешённых реестров.")
                if services.get("docker") != "active" and not has_install:
                    errors.append(f"Шаг {i}: для деплоя нужен запущенный Docker (добавьте docker.install раньше).")
                if any(s["tool"] == "app.deploy_compose" for s in steps):
                    errors.append(f"Шаг {i}: в плане допускается один деплой.")
        if name == "docker.install":
            has_install = True

        key = f"{name}:{sorted(params.items())}"
        if key in seen:
            errors.append(f"Шаг {i}: дублирует предыдущий шаг.")
            continue
        seen.add(key)
        steps.append({
            "id": f"s{i}", "tool": name, "title": spec.title(params), "params": params, "risk": spec.risk,
            "optional": spec.optional, "enabled": True, "expectedChange": spec.expected_change(params),
            "verify": spec.verify(params), "rollback": spec.rollback(params),
        })

    if not errors and not any(CATALOG[s["tool"]].mutating for s in steps):
        errors.append("План должен содержать хотя бы одно изменение; для чтения используйте инструменты чтения.")
    if errors:
        raise PolicyViolation(errors)
    return steps
