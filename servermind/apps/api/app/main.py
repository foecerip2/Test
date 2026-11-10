from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.core.config import get_settings
from app.core.permissions import ApiError
from app.db.session import get_engine
from app.modules.identity.router import router as identity_router
from app.modules.servers.router import router as servers_router


def create_app() -> FastAPI:
    s = get_settings()
    dev = s.environment == "development"
    app = FastAPI(title="ServerMind API", version="0.1.0", docs_url="/api/docs" if dev else None,
                  redoc_url=None, openapi_url="/api/openapi.json" if dev else None)

    @app.middleware("http")
    async def security_headers(request: Request, call_next):  # type: ignore[no-untyped-def]
        resp = await call_next(request)
        resp.headers["Cache-Control"] = "no-store"
        resp.headers["X-Content-Type-Options"] = "nosniff"
        resp.headers["Referrer-Policy"] = "no-referrer"
        return resp

    @app.exception_handler(ApiError)
    async def api_error(_: Request, e: ApiError) -> JSONResponse:
        return JSONResponse({"code": e.code, "message": e.message}, status_code=e.status_code)

    @app.exception_handler(RequestValidationError)
    async def validation_error(_: Request, e: RequestValidationError) -> JSONResponse:
        # не отражаем введённые значения (там могут быть секреты) — только поля
        fields = sorted({".".join(str(p) for p in err["loc"][1:]) for err in e.errors()})
        return JSONResponse({"code": "validation", "message": f"Некорректные данные: {', '.join(fields) or 'тело запроса'}."}, status_code=422)

    @app.get("/healthz")
    def healthz() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/readyz")
    def readyz() -> JSONResponse:
        try:
            with get_engine().connect() as c:
                c.execute(text("select 1"))
        except Exception:  # noqa: BLE001 — любая ошибка БД = не готов
            return JSONResponse({"status": "db_unavailable"}, status_code=503)
        return JSONResponse({"status": "ready"})

    app.include_router(identity_router, prefix="/api/v1")
    app.include_router(servers_router, prefix="/api/v1")
    return app


app = create_app()
