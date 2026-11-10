"""Контекст для модели: минимально необходимый, очищенный от секретов, обрезанный и ЯВНО помеченный как недоверенный.
IP-адрес и порт сервера модели не передаются."""

from __future__ import annotations

import json
from typing import Any

from app.core.security import redact
from app.db.models import Server, ServerMetricSample

_TOOL_CAP = 4000


def _fmt_time(t: Any) -> str | None:
    return t.strftime("%Y-%m-%dT%H:%M:%SZ") if t else None


def _wrap(payload: dict[str, Any], cap: int) -> str:
    text = redact(json.dumps(payload, ensure_ascii=False))
    return text if len(text) <= cap else text[:cap] + "…[обрезано]"


def facts_payload(server: Server, sample: ServerMetricSample | None) -> dict[str, Any]:
    return {
        "name": server.name[:80], "status": server.status, "last_checked_at_utc": _fmt_time(server.last_checked_at),
        "last_success_at_utc": _fmt_time(server.last_success_at),
        "os": (sample.os if sample else None) or server.os, "uptime_seconds": sample.uptime_seconds if sample else None,
        "cpu_percent": sample.cpu_percent if sample else None,
        "ram_used_mb": sample.ram_used_mb if sample else None, "ram_total_mb": sample.ram_total_mb if sample else None,
        "disk_used_gb": sample.disk_used_gb if sample else None, "disk_total_gb": sample.disk_total_gb if sample else None,
        "measured_at_utc": _fmt_time(sample.sampled_at) if sample else None,
    }


def context_block(server: Server, sample: ServerMetricSample | None, max_chars: int) -> str:
    return "<untrusted_server_data>\n" + _wrap(facts_payload(server, sample), min(max_chars, _TOOL_CAP)) + "\n</untrusted_server_data>"


def run_read_tool(name: str, server: Server, samples: list[ServerMetricSample]) -> tuple[str, str, list[str]]:
    """(результат для модели, краткое описание для UI, наблюдаемые факты). Читает только сохранённые данные, на сервер не ходит."""
    latest = samples[-1] if samples else None
    if name == "server.facts":
        p = facts_payload(server, latest)
        obs = [f"{k}: {v}" for k, v in p.items() if v is not None and k in ("status", "os", "measured_at_utc")]
        return "<untrusted_server_data>" + _wrap(p, _TOOL_CAP) + "</untrusted_server_data>", f"статус {server.status}, ОС {p['os'] or 'нет данных'}", obs
    if name == "server.metrics":
        pts = [{"t": _fmt_time(s.sampled_at), "cpu": s.cpu_percent, "ram_used_mb": s.ram_used_mb, "ram_total_mb": s.ram_total_mb,
                "disk_used_gb": s.disk_used_gb, "disk_total_gb": s.disk_total_gb} for s in samples[-24:]]
        obs = []
        if latest and latest.cpu_percent is not None:
            obs.append(f"CPU {latest.cpu_percent}%")
        if latest and latest.ram_used_mb is not None and latest.ram_total_mb:
            obs.append(f"RAM {latest.ram_used_mb} из {latest.ram_total_mb} МБ")
        if latest and latest.disk_used_gb is not None and latest.disk_total_gb:
            obs.append(f"Диск {latest.disk_used_gb} из {latest.disk_total_gb} ГБ")
        return "<untrusted_server_data>" + _wrap({"points": pts}, _TOOL_CAP) + "</untrusted_server_data>", f"точек: {len(pts)}", obs
    if name == "service.status":
        svc = list(latest.services) if latest else []
        obs = [f"{s['name']}: {s['state']}" for s in svc]
        return ("<untrusted_server_data>" + _wrap({"services": svc, "measured_at_utc": _fmt_time(latest.sampled_at) if latest else None}, _TOOL_CAP)
                + "</untrusted_server_data>"), (", ".join(obs) or "нет данных"), obs
    raise KeyError(name)
