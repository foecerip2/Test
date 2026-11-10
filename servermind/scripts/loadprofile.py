#!/usr/bin/env python3
"""Простой профиль нагрузки на API (только стандартная библиотека): N параллельных клиентов, M запросов на эндпоинт,
перцентили задержек и доля ошибок. Запускать ИЗ ТОЙ ЖЕ сети, где измеряется VPS; рядом снимайте `docker stats`.

  python3 scripts/loadprofile.py --base http://127.0.0.1:8000 --clients 20 --requests 400
Эндпоинты без входа: /healthz (процесс), /readyz (процесс + БД). Результат зависит от железа: числа с другой машины
НЕ переносятся на целевой VPS — не публикуйте их как показатели VPS."""

from __future__ import annotations

import argparse
import statistics
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor


def hit(url: str) -> tuple[float, bool]:
    t = time.perf_counter()
    try:
        with urllib.request.urlopen(url, timeout=10) as r:  # noqa: S310 — адрес задаёт оператор
            r.read()
            ok = 200 <= r.status < 300
    except (urllib.error.URLError, TimeoutError, OSError):
        ok = False
    return (time.perf_counter() - t) * 1000, ok


def run(base: str, path: str, clients: int, requests: int) -> None:
    url = base.rstrip("/") + path
    t0 = time.perf_counter()
    with ThreadPoolExecutor(max_workers=clients) as pool:
        res = list(pool.map(lambda _: hit(url), range(requests)))
    wall = time.perf_counter() - t0
    lat = sorted(x for x, _ in res)
    errs = sum(1 for _, ok in res if not ok)
    q = lambda p: lat[min(len(lat) - 1, int(len(lat) * p))]  # noqa: E731
    print(f"{path:10s} запросов={requests} клиентов={clients}  RPS={requests / wall:7.1f}  p50={q(0.50):6.1f} мс  p95={q(0.95):6.1f} мс  "
          f"p99={q(0.99):6.1f} мс  max={lat[-1]:6.1f} мс  среднее={statistics.fmean(lat):6.1f} мс  ошибок={errs}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:8000")
    ap.add_argument("--clients", type=int, default=20)
    ap.add_argument("--requests", type=int, default=400)
    a = ap.parse_args()
    for p in ("/healthz", "/readyz"):
        run(a.base, p, a.clients, a.requests)
