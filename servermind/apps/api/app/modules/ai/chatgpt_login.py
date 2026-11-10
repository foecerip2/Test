"""Локальный вход в ChatGPT для последующего импорта сессии на собственный VPS."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import tempfile
import time
import uuid
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlsplit

import jwt

from app.core.security import consteq, new_token
from app.modules.ai.chatgpt_auth import AUTHORIZE, ISSUER, PLAN_SCOPES, RESOURCE, exchange, listed_models, updated_session
from app.modules.ai.providers import ProviderError

CALLBACK_PATH = "/auth/callback"
CONFIG = Path.home() / ".config" / "servermind-chatgpt"


def save_private(path: Path, text: str) -> None:
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as temp:
        temporary_path = Path(temp.name)
        try:
            temp.write(text)
            temp.close()
            os.replace(temporary_path, path)
        finally:
            temporary_path.unlink(missing_ok=True)


def authorize(host_id: str, registration: dict[str, str]) -> tuple[dict[str, str], dict]:
    state, nonce, verifier = new_token(), new_token(), new_token()
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    result: dict[str, str] = {}

    class Callback(BaseHTTPRequestHandler):
        def log_message(self, format: str, *args: object) -> None:
            pass  # URL содержит одноразовый код OAuth.

        def do_GET(self) -> None:
            url = urlsplit(self.path)
            params = parse_qs(url.query)
            returned_state = params.get("state", [""])[0]
            if url.path != CALLBACK_PATH or not consteq(state, returned_state):
                self.send_error(400, "Invalid callback")
                return
            result.update({key: values[0] for key, values in params.items()})
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write("Ответ принят. Вернитесь в терминал для завершения входа.".encode())

    with HTTPServer(("127.0.0.1", 0), Callback) as server:
        server.timeout = 1
        redirect = f"http://127.0.0.1:{server.server_port}{CALLBACK_PATH}"
        issued_client_id = registration.get("client_id")
        query = {
            "client_id": issued_client_id or "dynamic_agent_client", "ext_agent_host_id": host_id,
            "response_type": "code", "redirect_uri": redirect, "resource": RESOURCE,
            "scope": " ".join(sorted({"openid", "profile", "email"} | PLAN_SCOPES)), "state": state,
            "nonce": nonce, "code_challenge_method": "S256", "code_challenge": challenge,
        }
        if not issued_client_id:
            query["agent_name_hint"] = "ServerMind"
        url = f"{AUTHORIZE}?{urlencode(query)}"
        print(f"Откройте официальный вход ChatGPT на этом устройстве:\n{url}", flush=True)
        webbrowser.open(url)
        deadline = time.monotonic() + 300
        while not result and time.monotonic() < deadline:
            server.handle_request()
    client_id = result.get("client_id") or issued_client_id
    if not client_id or not client_id.startswith("oaiapp_") or (issued_client_id and client_id != issued_client_id):
        raise ValueError("Регистрация OAuth не завершена.")
    if not result.get("code") or result.get("error"):
        raise ValueError("Авторизация отменена или истекла.")
    data = exchange({
        "grant_type": "authorization_code", "client_id": client_id, "code": result["code"],
        "code_verifier": verifier, "redirect_uri": redirect,
    }, 15)
    if not PLAN_SCOPES <= set(data.get("scope", "").split()):
        raise ValueError("OpenAI не предоставил доступ к использованию подписки.")
    token = data["id_token"]
    jwk = jwt.PyJWKClient(f"{ISSUER}/.well-known/jwks.json", timeout=15).get_signing_key_from_jwt(token)
    claims = jwt.decode(token, jwk.key, algorithms=["RS256", "ES256"], issuer=ISSUER, audience=client_id,
                        options={"require": ["iss", "aud", "exp", "sub", "nonce"]})
    if not consteq(nonce, claims["nonce"]) or (registration and registration["subject"] != claims["sub"]):
        raise ValueError("OpenAI вернул другое подтверждение входа или другой аккаунт.")
    if isinstance(claims["aud"], list) and len(claims["aud"]) > 1 and claims.get("azp") != client_id:
        raise ValueError("OpenAI вернул токен для другого приложения.")
    identity = {"client_id": client_id, "subject": claims["sub"]}
    if claims.get("email_verified") is True:
        identity["email"] = claims.get("email", "")
    return identity, data


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--new-account", action="store_true", help="зарегистрировать другой аккаунт ChatGPT")
    args = parser.parse_args()
    CONFIG.mkdir(parents=True, mode=0o700, exist_ok=True)
    CONFIG.chmod(0o700)
    host_file = CONFIG / "host-id"
    registration_file = CONFIG / "registration.json"
    try:
        if not host_file.exists():
            save_private(host_file, uuid.uuid4().urn)
        registration = json.loads(registration_file.read_text()) if registration_file.exists() and not args.new_account else {}
        identity, data = authorize(host_file.read_text().strip(), registration)
        session = updated_session(identity, data)
        models = listed_models(session.access_token, 15)
        if not models:
            raise ValueError("Для этого аккаунта OpenAI не вернул доступных моделей.")
        save_private(CONFIG / "session.json", session.model_dump_json())
        save_private(registration_file, json.dumps({"client_id": session.client_id, "subject": session.subject}))
    except ProviderError as error:
        raise SystemExit(error.message) from None
    except (ValueError, KeyError, TypeError, jwt.PyJWTError, OSError, AttributeError):
        raise SystemExit("Не удалось подключить ChatGPT. Проверьте подписку и повторите вход.") from None
    print(f"Доступные модели: {', '.join(models)}")
    print(f"Защищённый файл для переноса по SSH: {CONFIG / 'session.json'}")


if __name__ == "__main__":
    main()
