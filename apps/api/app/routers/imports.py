"""Импорт компаний из CSV: dry-run (ничего не пишет) и commit (полная перепроверка на сервере)."""

from __future__ import annotations

import json
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request
from pydantic import ValidationError
from sqlalchemy.orm import Session

from app.company_schemas import ImportCommitOut, ImportDryRunOut, ImportTextIn
from app.db import get_db
from app.deps import require_active_user_csrf
from app.models import User
from app.security import AppError
from app.services import companies as svc
from app.services.normalize import parse_csv

router = APIRouter(prefix="/api/v1/imports", tags=["imports"])

_CSV_TYPES = {"text/csv", "text/plain", "application/csv", "application/octet-stream"}


def _too_large() -> AppError:
    mb = svc.MAX_IMPORT_BYTES // (1024 * 1024)
    return AppError(413, "PAYLOAD_TOO_LARGE", f"Файл слишком большой: максимум {mb} МБ.")


async def _read_limited(request: Request) -> bytes:
    declared = request.headers.get("content-length")
    if declared is not None and declared.isdigit() and int(declared) > svc.MAX_IMPORT_BYTES:
        raise _too_large()
    chunks: list[bytes] = []
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > svc.MAX_IMPORT_BYTES:
            raise _too_large()
        chunks.append(chunk)
    return b"".join(chunks)


def _decode(raw: bytes) -> str:
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        pass
    try:  # Excel на русской Windows сохраняет CSV в cp1251
        return raw.decode("cp1251")
    except UnicodeDecodeError as exc:
        raise AppError(
            422, "INVALID_ENCODING", "Не удалось прочитать файл: нужна кодировка UTF-8 или cp1251."
        ) from exc


async def import_text(
    request: Request, _user: Annotated[User, Depends(require_active_user_csrf)]
) -> str:
    """Тело запроса -> текст CSV. Читается только после проверки сессии, роли и CSRF."""
    ctype = request.headers.get("content-type", "").split(";")[0].strip().lower()
    if ctype == "application/json":
        raw = await _read_limited(request)
        try:
            body = ImportTextIn.model_validate(json.loads(_decode(raw)))
        except (ValueError, ValidationError) as exc:
            raise AppError(422, "VALIDATION_ERROR", 'Ожидается JSON {"text": "..."}.') from exc
        if len(body.text.encode("utf-8")) > svc.MAX_IMPORT_BYTES:
            raise _too_large()
        return body.text
    if ctype not in _CSV_TYPES:
        raise AppError(415, "UNSUPPORTED_MEDIA_TYPE", "Передайте CSV (text/csv) или JSON {text}.")
    return _decode(await _read_limited(request))


def _parse_table(text: str) -> list[list[str]]:
    table = parse_csv(text)
    if len(table) < 2:
        raise AppError(422, "EMPTY_FILE", "В файле нет строк с данными.")
    if len(table) - 1 > svc.MAX_IMPORT_ROWS:
        raise AppError(
            422, "TOO_MANY_ROWS", f"Максимум {svc.MAX_IMPORT_ROWS} строк за один импорт."
        )
    return table


@router.post("/companies", response_model=ImportDryRunOut | ImportCommitOut)
def import_companies(
    user: Annotated[User, Depends(require_active_user_csrf)],
    text: Annotated[str, Depends(import_text)],
    db: Session = Depends(get_db),
    dry_run: bool = Query(default=True),
) -> ImportDryRunOut | ImportCommitOut:
    table = _parse_table(text)
    if dry_run:
        rows, missing = svc.plan_import(db, table)
        return ImportDryRunOut(
            rows=[svc.row_out(r) for r in rows],
            missing_columns=missing,
            summary=svc.summarize(rows),
        )
    res = svc.commit_import(db, user.id, table)
    return ImportCommitOut(
        job_id=res.job_id,
        rows_total=res.rows_total,
        added=res.added,
        skipped=res.skipped,
        candidates=res.candidates,
        summary=res.summary,
    )
