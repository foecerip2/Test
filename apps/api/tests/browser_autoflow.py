"""Только Playwright: настоящий API/SQLite и подставная почта, никогда не production."""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

import uvicorn

from app import security
from app.config import Settings
from app.db import Base
from app.main import create_app

if os.environ.get("AUTOFLOW_BROWSER_TEST") != "1":
    raise SystemExit("Only start with AUTOFLOW_BROWSER_TEST=1")


class BrowserMailer:
    def send(self, to: str, subject: str, text: str, html_body: str) -> None:
        pass  # никаких настоящих писем, код не возвращается API и не логируется


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="autoflow-browser-") as directory:
        settings = Settings(
            env="dev",
            database_url=f"sqlite+pysqlite:///{Path(directory) / 'test.db'}",
            owner_email="admin@example.com",
            public_origin="http://localhost:3100",
            autoflow_origins="http://localhost:3300",
            otp_resend_seconds=1,
        )
        security.generate_code = lambda: "123456"
        app = create_app(settings, BrowserMailer())  # type: ignore[arg-type]
        Base.metadata.create_all(app.state.engine)
        uvicorn.run(app, host="127.0.0.1", port=3311, log_level="warning")


if __name__ == "__main__":
    main()
