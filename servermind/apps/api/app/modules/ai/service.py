"""Цикл AI-чата. Модель — недоверенный планировщик:
- видит только очищенный минимальный контекст и результаты инструментов ЧТЕНИЯ по сохранённым данным;
- единственный «изменяющий» инструмент propose_plan НИЧЕГО не исполняет: через policy engine создаётся план `waiting_approval`;
- неизвестные инструменты, невалидные параметры и всё, что не прошло политику, отклоняются и пишутся в аудит;
- исполнения в этой фазе нет вообще (Фаза 4), поэтому даже полностью скомпрометированная модель не может изменить сервер."""

from __future__ import annotations

import datetime as dt
import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.auth import AuthContext, utcnow
from app.core.config import get_settings
from app.core.permissions import ApiError
from app.core.security import SlidingWindowLimiter, decrypt, redact
from app.db.models import ActionPlan, AiKey, AiUsage, Conversation, Message, Organization, Server, ServerMetricSample
from app.modules.ai import context as ctxmod
from app.modules.ai.prompts import SYSTEM_PROMPT, tool_defs
from app.modules.ai.providers import PROVIDERS, ProviderError, ToolCall
from app.modules.audit import service as audit
from app.modules.policy.catalog import READ_TOOLS
from app.modules.policy.engine import PolicyViolation, validate_proposal
from app.modules.policy.plan_hash import compute_hash, format_expires

_limiter: SlidingWindowLimiter | None = None
MAX_USER_TEXT = 4000
_ERR_STATUS = {"auth": (422, "ai_key_invalid"), "rate_limit": (429, "ai_rate_limit"), "timeout": (504, "ai_timeout"),
               "unavailable": (502, "ai_unavailable"), "bad_request": (502, "ai_error"), "bad_response": (502, "ai_error")}


def reset_limiter() -> None:
    global _limiter
    _limiter = None


def key_aad(org_id: Any, provider: str) -> bytes:
    return f"aikey:{org_id}:{provider}".encode()


def _guard(ctx: AuthContext) -> None:
    global _limiter
    s = get_settings()
    if _limiter is None or _limiter.limit != s.ai_requests_per_hour:
        _limiter = SlidingWindowLimiter(s.ai_requests_per_hour, 3600)
    if not _limiter.allow(str(ctx.user.id)):
        raise ApiError(429, "rate_limited", "Достигнут лимит AI-запросов в час. Повторите позже.")


def get_conversation(db: Session, ctx: AuthContext, server: Server) -> Conversation:
    conv = db.scalar(select(Conversation).where(Conversation.organization_id == ctx.org_id, Conversation.server_id == server.id,
                                                Conversation.user_id == ctx.user.id))
    if conv is None:
        conv = Conversation(organization_id=ctx.org_id, server_id=server.id, user_id=ctx.user.id)
        db.add(conv)
        db.flush()
    return conv


def _pick_key(db: Session, ctx: AuthContext) -> AiKey:
    org = db.get(Organization, ctx.org_id)
    if org is not None and org.ai_mode != "byok":
        raise ApiError(409, "mode_unavailable", "Режим кредитов пока недоступен (Фаза 5). Используйте собственный ключ.")
    key = db.scalar(select(AiKey).where(AiKey.organization_id == ctx.org_id, AiKey.status != "invalid").order_by(AiKey.created_at.desc()).limit(1))
    if key is None:
        raise ApiError(403, "no_key", "Не подключён ключ провайдера. Добавьте его в разделе «Биллинг».")
    return key


def _history(db: Session, conv: Conversation) -> list[dict[str, Any]]:
    s = get_settings()
    rows = db.scalars(select(Message).where(Message.conversation_id == conv.id).order_by(Message.created_at.desc()).limit(s.ai_history_messages)).all()
    out: list[dict[str, Any]] = []
    total = 0
    for m in rows:  # от новых к старым, пока влезаем в лимит контекста
        total += len(m.content)
        if total > s.ai_max_context_chars:
            break
        out.append({"role": m.role, "content": m.content})
    return list(reversed(out))


def _create_plan(db: Session, ctx: AuthContext, server: Server, conv: Conversation, args: dict[str, Any] | None,
                 latest: ServerMetricSample | None) -> tuple[str, bool, dict[str, Any] | None]:
    s = get_settings()
    if not isinstance(args, dict) or not isinstance(args.get("title"), str) or not isinstance(args.get("summary"), str) \
            or not isinstance(args.get("steps"), list) or set(args) - {"title", "summary", "steps"}:
        return "Отклонено: ожидаются поля title, summary, steps.", False, None
    try:
        steps = validate_proposal(args["steps"], server=server, latest=latest, role=ctx.role, settings=s)
    except PolicyViolation as e:
        audit.record(db, "ai.plan_rejected", org_id=ctx.org_id, actor_id=ctx.user.id, target=str(server.id), meta={"reasons": e.reasons[:8]})
        return "Отклонено политикой: " + " | ".join(e.reasons), False, None
    plan_id = uuid.uuid4()
    expires = utcnow().replace(microsecond=0) + dt.timedelta(minutes=s.plan_ttl_minutes)
    downtime = "Возможен короткий простой затронутых служб." if any(st["tool"] == "service.restart" for st in steps) else "Существующие службы не затрагиваются."
    plan = ActionPlan(
        id=plan_id, organization_id=ctx.org_id, server_id=server.id, conversation_id=conv.id, created_by=ctx.user.id, revision=1,
        title=redact(args["title"].strip())[:160] or "План", summary=redact(args["summary"].strip())[:1000], steps=steps, downtime=downtime,
        expires_at=expires, status="waiting_approval",
        canonical_hash=compute_hash(str(plan_id), str(server.id), 1, format_expires(expires), steps))
    db.add(plan)
    db.flush()
    audit.record(db, "plan.created", org_id=ctx.org_id, actor_id=ctx.user.id, target=str(plan_id), meta={"source": "ai", "steps": [x["tool"] for x in steps]})
    info = {"title": plan.title, "steps": [x["title"] for x in steps], "planId": str(plan_id)}
    return f"План {plan_id} создан и ожидает подтверждения человека. Ничего не выполнено.", True, info


def run_chat(db: Session, ctx: AuthContext, server: Server, text: str) -> tuple[Message, Message]:
    s = get_settings()
    text = text.strip()
    if not text or len(text) > MAX_USER_TEXT:
        raise ApiError(422, "validation", f"Сообщение — от 1 до {MAX_USER_TEXT} символов.")
    _guard(ctx)
    key = _pick_key(db, ctx)
    provider = PROVIDERS[key.provider]
    try:
        api_key = decrypt(s.master_key_bytes, key.key_enc, key_aad(ctx.org_id, key.provider)).decode()
    except Exception:  # noqa: BLE001 — любая ошибка расшифровки = конфигурация ключей
        raise ApiError(500, "crypto", "Не удалось расшифровать ключ провайдера.") from None

    conv = get_conversation(db, ctx, server)
    history = _history(db, conv)
    user_msg = Message(organization_id=ctx.org_id, conversation_id=conv.id, role="user", content=text, meta={})
    db.add(user_msg)
    db.flush()

    samples = list(reversed(db.scalars(select(ServerMetricSample).where(
        ServerMetricSample.server_id == server.id, ServerMetricSample.organization_id == ctx.org_id)
        .order_by(ServerMetricSample.sampled_at.desc()).limit(24)).all()))
    latest = samples[-1] if samples else None
    block = ctxmod.context_block(server, latest, s.ai_max_context_chars)
    messages: list[dict[str, Any]] = [*history, {"role": "user", "content": f"{block}\n\nВопрос пользователя:\n{text}"}]
    tools = tool_defs(can_propose=ctx.role in ("owner", "operator"))

    tool_log: list[dict[str, Any]] = []
    observed: list[str] = []
    proposal: dict[str, Any] | None = None
    final = ""
    try:
        for _ in range(s.ai_max_iterations):
            turn = provider.chat(api_key=api_key, model=key.model, system=SYSTEM_PROMPT, messages=messages, tools=tools,
                                 max_tokens=s.ai_max_output_tokens, timeout=s.ai_timeout_seconds)
            db.add(AiUsage(organization_id=ctx.org_id, user_id=ctx.user.id, provider=key.provider, model=key.model,
                           input_tokens=turn.input_tokens, output_tokens=turn.output_tokens))
            if not turn.tool_calls:
                final = turn.text
                break
            messages.append({"role": "assistant", "content": turn.text, "tool_calls": turn.tool_calls})
            for tc in turn.tool_calls:
                result, ok, summary, obs, plan_info = _handle_tool(db, ctx, server, conv, tc, samples, latest, proposal is not None)
                if plan_info:
                    proposal = plan_info
                observed.extend(obs)
                tool_log.append({"id": f"t{len(tool_log) + 1}", "tool": redact(tc.name)[:64], "args": "" if tc.name != "propose_plan" else "план", "status": "done" if ok else "error", "summary": summary})
                messages.append({"role": "tool", "tool_call_id": tc.id, "name": tc.name, "content": result})
        else:
            final = "Не удалось завершить анализ за допустимое число шагов. Уточните вопрос."
    except ProviderError as e:
        db.rollback()  # сообщение пользователя и частичные результаты не сохраняются — повтор не создаст дублей
        status, code = _ERR_STATUS.get(e.code, (502, "ai_error"))
        if e.code == "auth":
            row = db.get(AiKey, key.id)
            if row is not None:
                row.status = "invalid"
                db.commit()
        raise ApiError(status, code, e.message) from None

    final = redact(final).strip() or "Модель не вернула текст ответа."
    assistant = Message(organization_id=ctx.org_id, conversation_id=conv.id, role="assistant", content=final[:8000],
                        meta={"tools": tool_log, "observed": list(dict.fromkeys(observed))[:12], "proposal": proposal})
    db.add(assistant)
    audit.record(db, "ai.chat", org_id=ctx.org_id, actor_id=ctx.user.id, target=str(server.id), meta={"provider": key.provider, "tools": len(tool_log)})
    db.commit()
    return user_msg, assistant


def _handle_tool(db: Session, ctx: AuthContext, server: Server, conv: Conversation, tc: ToolCall,
                 samples: list[ServerMetricSample], latest: ServerMetricSample | None, plan_done: bool
                 ) -> tuple[str, bool, str, list[str], dict[str, Any] | None]:
    """(результат для модели, ok, описание для UI, наблюдаемые факты, информация о плане)."""
    if tc.name in READ_TOOLS:
        result, summary, obs = ctxmod.run_read_tool(tc.name, server, samples)
        return result, True, summary, obs, None
    if tc.name == "propose_plan":
        if ctx.role not in ("owner", "operator"):
            return "Отклонено: ваша роль не позволяет создавать планы.", False, "нет прав", [], None
        if plan_done:
            return "Отклонено: за одно сообщение допускается один план.", False, "второй план отклонён", [], None
        result, ok, info = _create_plan(db, ctx, server, conv, tc.arguments, latest)
        return result, ok, ("план создан, ждёт подтверждения" if ok else "отклонено политикой"), [], info
    # неизвестный инструмент (в т.ч. попытка выполнить команду) — отказ и аудит
    audit.record(db, "ai.unknown_tool", org_id=ctx.org_id, actor_id=ctx.user.id, target=str(server.id), meta={"tool": redact(tc.name)[:64]})
    return "Инструмент не разрешён.", False, "инструмент не разрешён", [], None


def to_chat_message(m: Message) -> dict[str, Any]:
    meta = m.meta or {}
    out: dict[str, Any] = {"id": str(m.id), "role": m.role, "text": m.content, "createdAt": m.created_at.strftime("%Y-%m-%dT%H:%M:%S.%fZ")}
    if m.role == "assistant":
        out["tools"] = meta.get("tools") or []
        out["observed"] = meta.get("observed") or []
        if meta.get("proposal"):
            out["proposal"] = meta["proposal"]
    return out

