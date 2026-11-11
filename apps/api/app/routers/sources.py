"""Реестр источников данных и их лицензионный статус (см. docs/SOURCES_AND_LICENSES.md)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request

from app.config import Settings
from app.deps import get_settings, require_active_user
from app.job_schemas import SourceListOut, SourceOut
from app.models import User

router = APIRouter(prefix="/api/v1/sources", tags=["sources"])

CATALOGS_DISABLED_REASON = "Включается только после проверки лицензии и условий источника."


def build_sources(settings: Settings) -> list[SourceOut]:
    return [
        SourceOut(
            id="csv",
            name="Ваши данные (импорт CSV)",
            enabled=True,
            description="Файлы, которые загружает сам пользователь; права на данные — у него.",
            rules=[
                "Хранится только результат разбора; сам файл не сохраняется.",
                "Срок хранения задаётся настройкой DATA_RETENTION_DAYS.",
            ],
            retention_days=settings.data_retention_days,
            disabled_reason=None,
        ),
        SourceOut(
            id="public_websites",
            name="Публичные сайты компаний",
            enabled=True,
            description="Только публично доступные страницы сайтов самих компаний.",
            rules=[
                "Соблюдаются robots.txt и условия использования сайта (ToS).",
                "Не более 5 страниц на домен за проверку и 1 запрос в 2 секунды.",
                "Не загружаются страницы за авторизацией; JavaScript не исполняется.",
                "Контакты организации не сохраняются: фиксируется только факт публикации.",
            ],
            retention_days=settings.data_retention_days,
            disabled_reason=None,
        ),
        SourceOut(
            id="catalogs",
            name="Каталоги и справочники",
            enabled=False,
            description="Сторонние каталоги организаций.",
            rules=["Подключение — только после проверки лицензии и условий источника."],
            retention_days=None,
            disabled_reason=CATALOGS_DISABLED_REASON,
        ),
    ]


@router.get("", response_model=SourceListOut)
def list_sources(
    request: Request,
    _user: User = Depends(require_active_user),
) -> SourceListOut:
    return SourceListOut(items=build_sources(get_settings(request)))
