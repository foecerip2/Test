"""Приложение FastAPI."""

from __future__ import annotations

import logging
import uuid
from collections.abc import Awaitable, Callable
from typing import Any
from urllib.parse import urlsplit

from fastapi import FastAPI, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.config import Settings
from app.db import make_engine, make_session_factory
from app.mail import Mailer, make_mailer
from app.routers import admin, auth, health
from app.security import AppError

log = logging.getLogger("leadhunter.api")

MUTATING = {"POST", "PUT", "PATCH", "DELETE"}

SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Cross-Origin-Resource-Policy": "same-origin",
}


def error_response(
    request: Request,
    status_code: int,
    code: str,
    message: str,
    headers: dict[str, str] | None = None,
    extra: dict[str, object] | None = None,
) -> JSONResponse:
    rid = getattr(request.state, "request_id", "-")
    body: dict[str, object] = {"code": code, "message": message, "request_id": rid}
    body.update(extra or {})
    return JSONResponse(body, status_code=status_code, headers=headers)


def origin_allowed(request: Request, settings: Settings) -> bool:
    expected = settings.public_origin_normalized
    origin = request.headers.get("origin")
    if origin is not None:
        return origin.strip().rstrip("/").lower() == expected
    referer = request.headers.get("referer")
    if referer:
        p = urlsplit(referer)
        return f"{p.scheme}://{p.netloc}".lower() == expected
    return True  # не-браузерные клиенты; мутации с сессией всё равно требуют CSRF


def create_app(settings: Settings | None = None, mailer: Mailer | None = None) -> FastAPI:
    settings = settings or Settings()
    engine = make_engine(settings.database_url)
    app = FastAPI(
        title="LeadHunter API",
        version="0.1.0",
        docs_url=None,
        redoc_url=None,
        openapi_url="/api/v1/openapi.json" if settings.env == "dev" else None,
    )
    app.state.settings = settings
    app.state.engine = engine
    app.state.session_factory = make_session_factory(engine)
    app.state.mailer = mailer or make_mailer(settings)

    @app.middleware("http")
    async def base_middleware(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        request.state.request_id = uuid.uuid4().hex
        response: Response
        if request.method in MUTATING and not origin_allowed(request, settings):
            response = error_response(
                request, 403, "ORIGIN_FORBIDDEN", "Запрос с недопустимого источника."
            )
        else:
            response = await call_next(request)
        response.headers["X-Request-ID"] = request.state.request_id
        for k, v in SECURITY_HEADERS.items():
            response.headers.setdefault(k, v)
        if request.url.path.startswith("/api/"):
            response.headers.setdefault("Cache-Control", "no-store")
        if settings.env == "prod" and settings.cookie_secure_effective:
            response.headers.setdefault(
                "Strict-Transport-Security", "max-age=31536000; includeSubDomains"
            )
        return response

    @app.exception_handler(AppError)
    async def _app_error(request: Request, exc: AppError) -> JSONResponse:
        return error_response(
            request, exc.status_code, exc.code, exc.message, exc.headers, exc.extra
        )

    @app.exception_handler(RequestValidationError)
    async def _validation(request: Request, exc: RequestValidationError) -> JSONResponse:
        return error_response(request, 422, "VALIDATION_ERROR", "Проверьте введённые данные.")

    @app.exception_handler(StarletteHTTPException)
    async def _http(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        codes = {
            404: ("NOT_FOUND", "Не найдено."),
            405: ("METHOD_NOT_ALLOWED", "Метод не разрешён."),
        }
        code, message = codes.get(exc.status_code, ("HTTP_ERROR", "Ошибка запроса."))
        return error_response(request, exc.status_code, code, message)

    @app.exception_handler(Exception)
    async def _unhandled(request: Request, exc: Exception) -> JSONResponse:
        log.error(
            "Необработанная ошибка (%s) request_id=%s",
            type(exc).__name__,
            getattr(request.state, "request_id", "-"),
        )
        return error_response(request, 500, "INTERNAL_ERROR", "Внутренняя ошибка сервера.")

    app.include_router(health.router)
    app.include_router(auth.router)
    app.include_router(admin.router)
    return app


_app: FastAPI | None = None


def __getattr__(name: str) -> Any:
    """Ленивое создание `app` для `uvicorn app.main:app` (импорт модуля не читает окружение)."""
    global _app
    if name == "app":
        if _app is None:
            _app = create_app()
        return _app
    raise AttributeError(name)
