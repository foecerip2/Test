"""Компании: фильтры, курсорная пагинация, события, импорт CSV, дашборд."""

from __future__ import annotations

import base64
import binascii
import json
import uuid
from collections.abc import Iterator
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta
from typing import Any, Literal, cast, get_args

import sqlalchemy as sa
from sqlalchemy import and_, case, func, or_, select, update
from sqlalchemy.engine import CursorResult
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker

from app import security
from app.company_schemas import (
    ActivityOut,
    CompanyDetailOut,
    CompanyOut,
    CrmStage,
    DashboardOut,
    DisplayOut,
    FactOut,
    ImportRowOut,
    ImportSummaryOut,
    ScoreReasonOut,
    Tone,
)
from app.models import (
    COMPANY_STATES,
    CRM_STAGES,
    ActivityEvent,
    AuditLog,
    Company,
    CompanyFact,
    ImportJob,
    LeadScore,
)
from app.security import AppError
from app.services.normalize import (
    ExistingCompany,
    ImportRow,
    csv_cell,
    map_import_rows,
    normalize_city,
    normalize_name,
)
from app.services.scoring import SCORE_RULE_VERSION, ScoreInput, import_score_input, score_company

SortKey = Literal["score", "name", "updated"]
Direction = Literal["asc", "desc"]
SORT_KEYS: tuple[str, ...] = get_args(SortKey)

# Ограничения импорта (ТЗ и план): размер файла и число строк.
MAX_IMPORT_BYTES = 2 * 1024 * 1024
MAX_IMPORT_ROWS = 5000
IMPORT_SOURCE_LABEL = "Импорт CSV"

# ---------------------------------------------------------------------------------------------
# Отображаемый статус (вычисляется из state + stage; черновики/диалоги появятся позже).

DISPLAY: dict[str, tuple[str, Tone]] = {
    "refused": ("Отказ", "red"),
    "rejected": ("Отклонена", "red"),
    "pilot": ("Пилот", "green"),
    "interested": ("Заинтересован", "green"),
    "replied": ("Ответил", "neutral"),
    "contacted": ("Контакт установлен", "neutral"),
    "new": ("Новый", "neutral"),
}


def display_key(state: str, stage: str) -> str:
    if stage == "lost":
        return "refused"
    if state == "rejected":
        return "rejected"
    if stage in ("pilot", "interested", "replied", "contacted"):
        return stage
    return "new"


def display_key_expr() -> sa.Case[str]:
    """SQL-версия display_key (для фильтра по статусу); тест сверяет обе реализации."""
    return case(
        (Company.stage == "lost", "refused"),
        (Company.state == "rejected", "rejected"),
        (Company.stage == "pilot", "pilot"),
        (Company.stage == "interested", "interested"),
        (Company.stage == "replied", "replied"),
        (Company.stage == "contacted", "contacted"),
        else_="new",
    )


def company_out(c: Company) -> CompanyOut:
    key = display_key(c.state, c.stage)
    label, tone = DISPLAY[key]
    return CompanyOut.model_validate(
        {
            "id": c.id,
            "name": c.name,
            "city": c.city,
            "category": c.category,
            "website": c.website,
            "domain": c.canonical_domain,
            "inn": c.inn,
            "state": c.state,
            "stage": c.stage,
            "score": c.score,
            "display": DisplayOut(key=key, label=label, tone=tone),
            "source_label": c.source_label,
            "created_at": c.created_at,
            "updated_at": c.updated_at,
            "demo": c.demo,
            "duplicate_candidate": c.duplicate_candidate,
        }
    )


def fold(s: str) -> str:
    return s.lower().replace("ё", "е")


def make_search_text(name: str, city: str, category: str, domain: str | None) -> str:
    return fold(f"{name} {city} {category} {domain or ''}")


# ---------------------------------------------------------------------------------------------
# Журнал: activity_events (append-only) и audit_logs.


def add_event(
    db: Session,
    company_id: uuid.UUID,
    event_type: str,
    actor_id: uuid.UUID | None,
    payload: dict[str, Any] | None = None,
    at: datetime | None = None,
) -> None:
    db.add(
        ActivityEvent(
            company_id=company_id,
            event_type=event_type,
            actor_id=actor_id,
            payload_redacted=payload,
            created_at=at or security.now(),
        )
    )


def add_audit(
    db: Session,
    actor_id: uuid.UUID,
    action: str,
    entity: str,
    entity_id: str,
    meta: dict[str, Any] | None = None,
) -> None:
    db.add(
        AuditLog(
            actor_id=actor_id,
            action=action,
            entity=entity,
            entity_id=entity_id,
            meta=meta,
            created_at=security.now(),
        )
    )


_EVENT_VIEW: dict[str, tuple[str, str]] = {
    "company.imported": ("download", "Импортирована из CSV"),
    "company.duplicate_candidate": ("info", "Возможный дубликат"),
    "company.stage_changed": ("columns", "Стадия изменена"),
    "company.note_updated": ("file", "Заметка обновлена"),
    "company.rejected": ("shield", "Компания отклонена"),
    "company.score_recalculated": ("check", "Оценка пересчитана"),
    "company.site_checked": ("globe", "Сайт проверен"),
}


def _event_text(event_type: str, p: dict[str, Any]) -> str:
    if event_type == "company.imported":
        return f"Строка {p.get('line', '?')}"
    if event_type == "company.duplicate_candidate":
        return f"Похожа на «{p.get('of', '')}» — проверьте вручную"
    if event_type == "company.stage_changed":
        return f"Новая стадия: {p.get('to', '')}"
    if event_type == "company.rejected":
        return "Исключена из работы"
    if event_type == "company.score_recalculated":
        return f"{p.get('from', '?')} → {p.get('to', '?')}"
    if event_type == "company.site_checked":
        return f"Проверено страниц: {p.get('pages_checked', 0)}, фактов: {p.get('facts', 0)}"
    return ""


def activity_out(e: ActivityEvent, company_name: str | None = None) -> ActivityOut:
    icon, title = _EVENT_VIEW.get(e.event_type, ("check", e.event_type))
    return ActivityOut(
        id=e.id,
        event_type=e.event_type,
        icon=icon,
        title=title,
        text=_event_text(e.event_type, e.payload_redacted or {}),
        at=e.created_at,
        company_id=e.company_id,
        company_name=company_name,
    )


# ---------------------------------------------------------------------------------------------
# Список: фильтры, сортировка, курсорная пагинация.


@dataclass
class CompanyFilter:
    query: str | None = None
    city: str | None = None
    score_min: int | None = None
    status: str | None = None
    sort: SortKey = "score"
    dir: Direction = "desc"


def _like_escape(s: str) -> str:
    return s.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def filter_conditions(f: CompanyFilter) -> list[sa.ColumnElement[bool]]:
    conds: list[sa.ColumnElement[bool]] = []
    q = fold((f.query or "").strip())
    if q:
        conds.append(Company.search_text.like(f"%{_like_escape(q)}%", escape="\\"))
    if f.city and f.city.strip():
        conds.append(Company.city_norm == normalize_city(f.city))
    if f.score_min:
        conds.append(Company.score >= f.score_min)
    if f.status:
        conds.append(display_key_expr() == f.status)
    return conds


def _sort_column(sort: str) -> sa.ColumnElement[Any]:
    if sort == "name":
        return cast(sa.ColumnElement[Any], Company.normalized_name)
    if sort == "updated":
        return cast(sa.ColumnElement[Any], Company.updated_at)
    return cast(sa.ColumnElement[Any], Company.score)


def _order_by(f: CompanyFilter) -> list[sa.UnaryExpression[Any]]:
    col = _sort_column(f.sort)
    if f.dir == "asc":
        return [col.asc(), Company.id.asc()]
    return [col.desc(), Company.id.desc()]  # id — стабильный tie-breaker при равных значениях


def _cursor_value(c: Company, sort: str) -> Any:
    if sort == "name":
        return c.normalized_name
    if sort == "updated":
        return c.updated_at.isoformat()
    return c.score


def encode_cursor(c: Company, f: CompanyFilter) -> str:
    raw = json.dumps(
        {"s": f.sort, "d": f.dir, "v": _cursor_value(c, f.sort), "i": str(c.id)},
        separators=(",", ":"),
    )
    return base64.urlsafe_b64encode(raw.encode()).decode().rstrip("=")


def decode_cursor(cursor: str, f: CompanyFilter) -> tuple[Any, uuid.UUID]:
    try:
        d = json.loads(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)))
        if not isinstance(d, dict) or d.get("s") != f.sort or d.get("d") != f.dir:
            raise ValueError("cursor mismatch")
        value = d["v"]
        cid = uuid.UUID(str(d["i"]))
        if f.sort == "score":
            if isinstance(value, bool) or not isinstance(value, int):
                raise ValueError("score")
        elif f.sort == "name":
            if not isinstance(value, str):
                raise ValueError("name")
        else:
            if not isinstance(value, str):
                raise ValueError("updated")
            value = datetime.fromisoformat(value)
            if value.tzinfo is None:
                raise ValueError("naive")
        return value, cid
    except (ValueError, KeyError, TypeError, binascii.Error) as exc:
        raise AppError(422, "INVALID_CURSOR", "Некорректный курсор. Обновите список.") from exc


def _keyset(f: CompanyFilter, value: Any, cid: uuid.UUID) -> sa.ColumnElement[bool]:
    col = _sort_column(f.sort)
    if f.dir == "asc":
        return or_(col > value, and_(col == value, Company.id > cid))
    return or_(col < value, and_(col == value, Company.id < cid))


@dataclass
class CompanyPageData:
    items: list[Company]
    total: int
    cities: list[str]
    has_more: bool
    next_cursor: str | None


def list_cities(db: Session) -> list[str]:
    cities = db.scalars(select(Company.city).distinct()).all()
    return sorted(cities, key=lambda s: s.casefold())


def list_companies(
    db: Session, f: CompanyFilter, limit: int, cursor: str | None = None
) -> CompanyPageData:
    conds = filter_conditions(f)
    total = db.scalar(select(func.count()).select_from(Company).where(*conds)) or 0
    stmt = select(Company).where(*conds)
    if cursor:
        value, cid = decode_cursor(cursor, f)
        stmt = stmt.where(_keyset(f, value, cid))
    rows = list(db.scalars(stmt.order_by(*_order_by(f)).limit(limit + 1)))
    has_more = len(rows) > limit
    rows = rows[:limit]
    return CompanyPageData(
        items=rows,
        total=total,
        cities=list_cities(db),
        has_more=has_more,
        next_cursor=encode_cursor(rows[-1], f) if has_more and rows else None,
    )


EXPORT_HEADER: list[str | int | float] = [
    "Компания",
    "Город",
    "Категория",
    "Сайт",
    "Оценка",
    "Статус",
]


def _export_line(c: Company) -> str:
    label = DISPLAY[display_key(c.state, c.stage)][0]
    cells: list[str | int | float] = [
        c.name,
        c.city,
        c.category,
        c.canonical_domain or "",
        c.score,
        label,
    ]
    return ";".join(csv_cell(v) for v in cells)


def export_csv_stream(
    factory: sessionmaker[Session], f: CompanyFilter, page_size: int = 500
) -> Iterator[str]:
    """CSV потоком (формат как `toCsv` эталона: BOM, `;`, CRLF, защита от инъекций).

    Использует собственную сессию: зависимость запроса к моменту отправки тела уже закрыта.
    """
    yield "﻿" + ";".join(csv_cell(v) for v in EXPORT_HEADER)
    cursor: str | None = None
    with factory() as db:
        while True:
            page = list_companies(db, f, page_size, cursor)
            for c in page.items:
                yield "\r\n" + _export_line(c)
            if not page.has_more:
                return
            cursor = page.next_cursor


# ---------------------------------------------------------------------------------------------
# Карточка компании.


def detail_out(db: Session, c: Company) -> CompanyDetailOut:
    facts = db.scalars(
        select(CompanyFact)
        .where(CompanyFact.company_id == c.id)
        .order_by(
            case((CompanyFact.kind == "confirmed", 0), else_=1),
            CompanyFact.observed_at.desc(),
            CompanyFact.id,
        )
    ).all()
    ls = db.scalar(select(LeadScore).where(LeadScore.company_id == c.id))
    events = db.scalars(
        select(ActivityEvent)
        .where(ActivityEvent.company_id == c.id)
        .order_by(ActivityEvent.created_at.desc(), ActivityEvent.id.desc())
        .limit(50)
    ).all()
    return CompanyDetailOut(
        **company_out(c).model_dump(),
        note=c.note,
        facts=[
            FactOut.model_validate(
                {
                    "id": f.id,
                    "text": f.text,
                    "kind": f.kind,
                    "evidence_url": f.evidence_url,
                    "evidence_excerpt": f.evidence_excerpt,
                    "observed_at": f.observed_at,
                    "confidence": f.confidence,
                }
            )
            for f in facts
        ],
        score_reasons=[ScoreReasonOut(**r) for r in (ls.reasons if ls else [])],
        score_version=ls.rule_version if ls else None,
        history=[activity_out(e) for e in events],
    )


# ---------------------------------------------------------------------------------------------
# Изменения: стадия, заметка, отклонение, пересчёт оценки.


def get_company(db: Session, company_id: uuid.UUID) -> Company:
    c = db.get(Company, company_id)
    if c is None:
        raise AppError(404, "NOT_FOUND", "Компания не найдена.")
    return c


def _score_row(inp: ScoreInput) -> tuple[int, list[dict[str, Any]], dict[str, Any]]:
    score, reasons = score_company(inp)
    return score, [dict(r) for r in reasons], asdict(inp)


def create_score(db: Session, c: Company, inp: ScoreInput, now: datetime) -> None:
    """Первичная оценка при создании компании."""
    score, reasons, inputs = _score_row(inp)
    db.add(
        LeadScore(
            company_id=c.id,
            score=score,
            rule_version=SCORE_RULE_VERSION,
            reasons=reasons,
            inputs=inputs,
            created_at=now,
        )
    )
    c.score = score


def rescore_refusal(db: Session, c: Company, actor_id: uuid.UUID) -> None:
    """Пересчёт после отказа (стадия `lost`): снимаются баллы правила «чисто»."""
    ls = db.scalar(select(LeadScore).where(LeadScore.company_id == c.id))
    inp = ScoreInput(**ls.inputs) if ls else import_score_input(c.category)
    inp.has_refusal = c.stage == "lost"
    score, reasons, inputs = _score_row(inp)
    old = c.score
    if ls is None:
        create_score(db, c, inp, security.now())
    else:
        ls.score = score
        ls.rule_version = SCORE_RULE_VERSION
        ls.reasons = reasons
        ls.inputs = inputs
        c.score = score
    if old != score:
        add_event(db, c.id, "company.score_recalculated", actor_id, {"from": old, "to": score})


def change_stage(
    db: Session,
    c: Company,
    new_stage: CrmStage,
    expected: CrmStage | None,
    actor_id: uuid.UUID,
) -> bool:
    """Меняет стадию CRM. Возвращает False, если стадия уже такая же (событий нет)."""
    current = c.stage
    if expected is not None and current != expected:
        raise AppError(
            409,
            "STAGE_CONFLICT",
            "Стадия уже изменена другим пользователем. Обновите карточку.",
            extra={"current_stage": current},
        )
    if current == "lost" and new_stage != "lost":
        raise AppError(
            409,
            "SUPPRESSION_PERMANENT",
            "У компании есть отказ — стадию нельзя вернуть без нового законного основания.",
        )
    if current == new_stage:
        return False
    now = security.now()
    res = cast(
        CursorResult[Any],
        db.execute(
            update(Company)
            .where(Company.id == c.id, Company.stage == current)
            .values(stage=new_stage, updated_at=now)
            .execution_options(synchronize_session=False)
        ),
    )
    if res.rowcount != 1:  # конкурентное изменение между чтением и записью (compare-and-set)
        db.rollback()
        raise AppError(
            409, "STAGE_CONFLICT", "Стадия уже изменена другим пользователем. Обновите карточку."
        )
    db.refresh(c)
    add_event(db, c.id, "company.stage_changed", actor_id, {"from": current, "to": new_stage}, now)
    add_audit(
        db, actor_id, "company.stage", "company", str(c.id), {"from": current, "to": new_stage}
    )
    if new_stage == "lost":
        rescore_refusal(db, c, actor_id)
    return True


def set_note(db: Session, c: Company, note: str, actor_id: uuid.UUID) -> bool:
    if c.note == note:
        return False
    now = security.now()
    c.note = note
    c.updated_at = now
    # Текст заметки в журналы не пишем (может содержать лишнее) — только длину.
    add_event(db, c.id, "company.note_updated", actor_id, {"length": len(note)}, now)
    add_audit(db, actor_id, "company.note", "company", str(c.id), {"length": len(note)})
    return True


def reject_company(db: Session, c: Company, actor_id: uuid.UUID) -> bool:
    if c.state == "archived":
        raise AppError(409, "INVALID_STATE", "Архивную компанию нельзя отклонить.")
    if c.state == "rejected":
        return False
    now = security.now()
    prev = c.state
    c.state = "rejected"
    c.updated_at = now
    add_event(db, c.id, "company.rejected", actor_id, {"from": prev}, now)
    add_audit(db, actor_id, "company.reject", "company", str(c.id), {"from": prev})
    return True


# ---------------------------------------------------------------------------------------------
# Импорт CSV.


def _import_extra_issues(name: str, city: str, category: str, website: str | None) -> list[str]:
    """Серверные проверки поверх эталона: длины полей БД и символы, недопустимые в PostgreSQL."""
    issues: list[str] = []
    if "\x00" in name or "\x00" in city or "\x00" in category:
        issues.append("Недопустимые символы")
    if len(name) > 300:
        issues.append("Слишком длинное название")
    if len(city) > 120:
        issues.append("Слишком длинное название города")
    if len(category) > 200:
        issues.append("Слишком длинная категория")
    if website is not None and len(website) > 253:
        issues.append("Слишком длинный сайт")
    return issues


def _chunks(values: list[str], n: int = 400) -> Iterator[list[str]]:
    for i in range(0, len(values), n):
        yield values[i : i + n]


def _load_existing(db: Session, rows: list[ImportRow]) -> list[ExistingCompany]:
    """Только компании из БД, которые могут совпасть со строками файла (ИНН/домен/название)."""
    inns = sorted({r.inn for r in rows if r.inn})
    domains = sorted({r.website for r in rows if r.website})
    names = sorted({n for n in (normalize_name(r.name) for r in rows) if n})
    found: dict[uuid.UUID, Company] = {}
    for col, values in (
        (Company.inn, inns),
        (Company.canonical_domain, domains),
        (Company.normalized_name, names),
    ):
        for chunk in _chunks(values):
            for c in db.scalars(select(Company).where(col.in_(chunk))):
                found[c.id] = c
    ordered = sorted(found.values(), key=lambda c: (c.created_at, str(c.id)))
    return [ExistingCompany(c.name, c.city, c.canonical_domain, c.inn) for c in ordered]


def plan_import(db: Session, table: list[list[str]]) -> tuple[list[ImportRow], list[str]]:
    """Разбор и дедупликация по актуальному состоянию БД (и для dry-run, и для commit)."""
    first_pass, missing = map_import_rows(table, [], _import_extra_issues)
    if missing:
        return [], missing
    existing = _load_existing(db, first_pass)
    return map_import_rows(table, existing, _import_extra_issues)


def is_importable(r: ImportRow) -> bool:
    return not r.issues and (r.duplicate is None or r.duplicate.kind == "candidate")


def summarize(rows: list[ImportRow]) -> ImportSummaryOut:
    return ImportSummaryOut(
        total=len(rows),
        importable=sum(1 for r in rows if is_importable(r)),
        with_issues=sum(1 for r in rows if r.issues),
        exact=sum(1 for r in rows if r.duplicate and r.duplicate.kind == "exact"),
        in_file=sum(1 for r in rows if r.duplicate and r.duplicate.kind == "in_file"),
        candidates=sum(1 for r in rows if r.duplicate and r.duplicate.kind == "candidate"),
    )


def row_out(r: ImportRow) -> ImportRowOut:
    return ImportRowOut.model_validate(
        {
            "line": r.line,
            "name": r.name,
            "city": r.city,
            "category": r.category,
            "website": r.website,
            "inn": r.inn,
            "issues": r.issues,
            "duplicate": {"kind": r.duplicate.kind, "of": r.duplicate.of} if r.duplicate else None,
        }
    )


@dataclass
class ImportResult:
    job_id: uuid.UUID
    rows_total: int
    added: int
    skipped: int
    candidates: int
    summary: ImportSummaryOut


def commit_import(db: Session, user_id: uuid.UUID, table: list[list[str]]) -> ImportResult:
    """Импорт с полной серверной перепроверкой (клиентским флагам и dry-run не верим).

    В базу попадают строки без ошибок; точные дубли (ИНН, домен+город) и дубли внутри файла
    пропускаются; «похожее название» добавляется с пометкой кандидата. Баллы только за то, что
    известно из файла: сайт не проверялся (site_works=False), онлайн-запись — не проверялась.
    """
    for _attempt in range(3):
        rows, missing = plan_import(db, table)
        if missing:
            raise AppError(
                422,
                "MISSING_COLUMNS",
                "В файле нет обязательных колонок: " + ", ".join(missing) + ".",
                extra={"missing_columns": missing},
            )
        summary = summarize(rows)
        skipped = len(rows) - summary.importable
        now = security.now()
        job = ImportJob(
            id=uuid.uuid4(),
            user_id=user_id,
            status="succeeded",
            rows_total=len(rows),
            rows_added=summary.importable,
            rows_skipped=skipped,
            created_at=now,
        )
        try:
            new: list[tuple[Company, ImportRow]] = []
            for r in rows:
                if not is_importable(r):
                    continue
                new.append(
                    (
                        Company(
                            id=uuid.uuid4(),
                            name=r.name,
                            normalized_name=normalize_name(r.name),
                            inn=r.inn,
                            city=r.city,
                            city_norm=normalize_city(r.city),
                            category=r.category,
                            website=f"https://{r.website}" if r.website else None,
                            canonical_domain=r.website,
                            state="discovered",
                            stage="new",
                            note="",
                            source_label=IMPORT_SOURCE_LABEL,
                            demo=False,
                            duplicate_candidate=r.duplicate is not None,  # только "candidate"
                            score=0,
                            search_text=make_search_text(r.name, r.city, r.category, r.website),
                            created_at=now,
                            updated_at=now,
                        ),
                        r,
                    )
                )
            db.add_all([c for c, _ in new])
            db.flush()  # уникальный ИНН проверяется здесь: гонка двух импортов -> IntegrityError
            for c, r in new:
                inp = import_score_input(c.category, duplicate_candidate=c.duplicate_candidate)
                create_score(db, c, inp, now)
                payload = {"line": r.line, "job_id": str(job.id)}
                add_event(db, c.id, "company.imported", user_id, payload, now)
                if r.duplicate is not None:
                    add_event(
                        db,
                        c.id,
                        "company.duplicate_candidate",
                        user_id,
                        {"of": r.duplicate.of},
                        now + timedelta(milliseconds=1),
                    )
            db.add(job)
            add_audit(
                db,
                user_id,
                "import.commit",
                "import",
                str(job.id),
                {
                    "rows_total": len(rows),
                    "added": summary.importable,
                    "skipped": skipped,
                    "candidates": summary.candidates,
                },
            )
            db.commit()
        except IntegrityError:
            db.rollback()  # параллельный импорт успел вставить тот же ИНН — перепланируем
            continue
        return ImportResult(
            job_id=job.id,
            rows_total=len(rows),
            added=summary.importable,
            skipped=skipped,
            candidates=summary.candidates,
            summary=summary,
        )
    raise AppError(409, "IMPORT_CONFLICT", "Данные изменились во время импорта. Повторите попытку.")


# ---------------------------------------------------------------------------------------------
# Дашборд: только агрегаты из БД.


def dashboard(db: Session, threshold: int) -> DashboardOut:
    now = security.now()
    count = select(func.count()).select_from(Company)
    total = db.scalar(count) or 0
    week = db.scalar(count.where(Company.created_at >= now - timedelta(days=7))) or 0
    suitable = (
        db.scalar(
            count.where(
                Company.score >= threshold, Company.state != "rejected", Company.stage != "lost"
            )
        )
        or 0
    )
    by_stage = dict.fromkeys(CRM_STAGES, 0)
    for stage, n in db.execute(select(Company.stage, func.count()).group_by(Company.stage)):
        by_stage[stage] = n
    by_state = dict.fromkeys(COMPANY_STATES, 0)
    for state, n in db.execute(select(Company.state, func.count()).group_by(Company.state)):
        by_state[state] = n
    top = db.scalars(
        select(Company)
        .where(Company.state != "rejected", Company.stage != "lost")
        .order_by(Company.score.desc(), Company.id.desc())
        .limit(4)
    ).all()
    recent_rows = db.execute(
        select(ActivityEvent, Company.name)
        .join(Company, Company.id == ActivityEvent.company_id)
        .order_by(ActivityEvent.created_at.desc(), ActivityEvent.id.desc())
        .limit(5)
    ).all()
    return DashboardOut(
        companies_total=total,
        companies_week=week,
        suitable=suitable,
        score_threshold=threshold,
        by_stage=by_stage,
        by_state=by_state,
        top_companies=[company_out(c) for c in top],
        recent=[activity_out(e, name) for e, name in recent_rows],
    )
