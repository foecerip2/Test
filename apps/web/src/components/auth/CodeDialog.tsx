"use client";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { Modal } from "@/components/Modal";
import { ApiError, getApi, type OtpChallenge, type OtpVerified } from "@/lib/api";
import { authErrorText, maskEmail } from "@/lib/auth";
import { emptyCells } from "@/lib/otp";
import { CodeInput, type CodeInputHandle } from "./CodeInput";
import { ResendTimer } from "./ResendTimer";
import { SuccessCheck } from "./SuccessCheck";
import s from "./auth.module.css";

type Status = "idle" | "verifying" | "expired" | "locked" | "success";
type Message = { tone: "error" | "info"; text: string } | null;

/** Тайминги анимации успеха (мс): сборка ячеек → круг → галочка → пульс → подпись → уход. */
const HOLD_MS = 1150;
const HOLD_REDUCED_MS = 800;
const LEAVE_MS = 300;

const prefersReducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** Окно «Код подтверждения»: диалог на десктопе, нижний лист на телефоне. */
export function CodeDialog({ email, challenge, onClose, onChangeEmail, onDone }: {
  email: string;
  challenge: OtpChallenge;
  onClose: () => void;
  onChangeEmail: () => void;
  onDone: (r: OtpVerified) => void;
}) {
  const api = getApi();
  const descId = useId();
  const [challengeId, setChallengeId] = useState(challenge.challengeId);
  const [cells, setCells] = useState<string[]>(emptyCells());
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState<Message>(null);
  const [resendIn, setResendIn] = useState(challenge.resendIn);
  const [resendKey, setResendKey] = useState(0);
  const [resending, setResending] = useState(false);
  const [expiresAt, setExpiresAt] = useState(() => Date.now() + challenge.expiresIn * 1000);
  const [result, setResult] = useState<OtpVerified | null>(null);
  const [leaving, setLeaving] = useState(false);
  const input = useRef<CodeInputHandle>(null);
  const dialogBody = useRef<HTMLDivElement>(null);
  const statusRef = useRef<Status>("idle");
  statusRef.current = status;
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  // Фокус на первую ячейку ставится ПОСЛЕ коммита, когда поля уже разблокированы (иначе на медленных устройствах
  // focus() попадал в ещё заблокированное поле и терялся).
  const [focusTick, setFocusTick] = useState(0);
  const focusFirst = useCallback(() => { setFocusTick((t) => t + 1); }, []);
  useEffect(() => { if (focusTick > 0) input.current?.focus(0); }, [focusTick]);

  // Срок действия кода: по истечении просим отправить новый.
  useEffect(() => {
    const ms = Math.max(0, expiresAt - Date.now());
    const id = setTimeout(() => {
      if (statusRef.current === "idle") {
        setStatus("expired"); setCells(emptyCells());
        setMessage({ tone: "error", text: "Срок действия кода истёк. Отправьте новый код." });
      }
    }, ms);
    return () => clearTimeout(id);
  }, [expiresAt]);

  async function verify(code: string) {
    if (statusRef.current === "verifying" || statusRef.current === "success") return;
    setStatus("verifying"); setMessage(null);
    try {
      const r = await api.auth.verifyCode(challengeId, code);
      if (!alive.current) return;
      setResult(r); setStatus("success");
    } catch (e) {
      if (!alive.current) return;
      const err = e instanceof ApiError ? e : null;
      setCells(emptyCells());
      if (err?.code === "INVALID_CODE") {
        const left = err.details.attemptsLeft;
        if (left === 0) { setStatus("locked"); setMessage({ tone: "error", text: "Слишком много неверных попыток. Запросите новый код." }); return; }
        setStatus("idle");
        setMessage({ tone: "error", text: left !== undefined ? `Неверный код. Осталось попыток: ${left}` : "Неверный код. Проверьте письмо и повторите." });
        focusFirst();
      } else if (err?.code === "CODE_EXPIRED" || err?.status === 410) {
        setStatus("expired"); setMessage({ tone: "error", text: "Срок действия кода истёк. Отправьте новый код." });
      } else if (err?.code === "TOO_MANY_ATTEMPTS" || err?.status === 429) {
        setStatus("locked"); setMessage({ tone: "error", text: "Слишком много неверных попыток. Запросите новый код." });
      } else {
        setStatus("idle"); setMessage({ tone: "error", text: authErrorText(err?.code ?? "UNKNOWN", err?.details.retryAfter) });
        focusFirst();
      }
    }
  }

  async function resend() {
    setResending(true); setMessage(null);
    try {
      let nextResend: number;
      let nextExpires = challenge.expiresIn;
      try {
        nextResend = (await api.auth.resendCode(challengeId)).resendIn;
      } catch (e) {
        // Запрос уже не существует на сервере (истёк): начинаем заново для того же email.
        if (e instanceof ApiError && (e.status === 410 || e.status === 404)) {
          const c = await api.auth.requestCode(email);
          if (!alive.current) return;
          setChallengeId(c.challengeId); nextResend = c.resendIn; nextExpires = c.expiresIn;
        } else throw e;
      }
      if (!alive.current) return;
      setResendIn(nextResend); setResendKey((k) => k + 1);
      setExpiresAt(Date.now() + nextExpires * 1000);
      setCells(emptyCells()); setStatus("idle");
      setMessage({ tone: "info", text: "Новый код отправлен. Старый больше не действует." });
      focusFirst();
    } catch (e) {
      if (!alive.current) return;
      const err = e instanceof ApiError ? e : null;
      if (err?.code === "RATE_LIMITED" && err.details.retryAfter) { setResendIn(err.details.retryAfter); setResendKey((k) => k + 1); }
      setMessage({ tone: "error", text: authErrorText(err?.code ?? "UNKNOWN", err?.details.retryAfter) });
    }
    setResending(false);
  }

  // Анимация успеха: ячейки собираются к центру круга; затем плавный уход и переход.
  useLayoutEffect(() => {
    if (status !== "success") return;
    const body = dialogBody.current;
    const group = input.current?.element();
    const badge = body?.closest("[role=dialog]")?.querySelector<HTMLElement>("[data-badge]");
    const cellEls = group?.querySelectorAll<HTMLElement>("input");
    if (!group || !badge || !cellEls || cellEls.length < 2) return;
    const g = group.getBoundingClientRect();
    const b = badge.getBoundingClientRect();
    const a = cellEls[0]!.getBoundingClientRect(), c = cellEls[1]!.getBoundingClientRect();
    group.style.setProperty("--dy", `${Math.round(b.top + b.height / 2 - (g.top + g.height / 2))}px`);
    group.style.setProperty("--pitch", `${c.left - a.left}px`);
  }, [status]);

  useEffect(() => {
    if (status !== "success" || !result) return;
    const reduced = prefersReducedMotion();
    const t1 = setTimeout(() => { setLeaving(true); }, reduced ? HOLD_REDUCED_MS : HOLD_MS);
    const t2 = setTimeout(() => { if (alive.current) onDone(result); }, (reduced ? HOLD_REDUCED_MS : HOLD_MS) + (reduced ? 0 : LEAVE_MS));
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [status, result, onDone]);

  const done = status === "success";
  const blocked = status === "expired" || status === "locked";
  const busy = status === "verifying";
  const title = result?.isNew ? "Аккаунт создан" : "Готово — добро пожаловать";
  const phase = leaving ? "leaving" : done ? "success" : "idle";
  const live = done ? (result?.isNew ? "Код принят. Аккаунт создан." : "Код принят. Добро пожаловать.") : busy ? "Проверяем код" : "";

  return (
    <Modal
      title="Введите код из письма" onClose={() => { if (!done) onClose(); }} variant="sheet" describedBy={descId}
      dialogClass={s.dialog} titleClass={`${s.title} ${s.fade}`} dismissOnBackdrop={false} phase={phase}
    >
      <button type="button" className={`icon-btn ${s.close} ${s.fade}`} aria-label="Закрыть" onClick={onClose}><Icon name="close" /></button>
      <div ref={dialogBody} className={s.body}>
        <div className={s.fade}>
          <div id={descId} className={s.lead}>
            Мы отправили код на <strong>{maskEmail(email)}</strong>.{" "}
            <button type="button" className={`link-btn ${s.change}`} onClick={onChangeEmail}>Изменить email</button>
          </div>
        </div>

        <CodeInput
          ref={input} cells={cells} describedBy={descId}
          onChange={(c) => { setCells(c); if (message?.tone === "error" && !blocked) setMessage(null); }}
          onComplete={verify}
          disabled={busy || blocked || done} busy={busy} invalid={message?.tone === "error" && !blocked && status === "idle"} collapse={done}
        />

        <div className={`${s.fade} ${s.msgWrap}`}>
          <div className={`${s.msg} ${s.err}`} role="alert">{message?.tone === "error" ? message.text : ""}</div>
          {message?.tone === "info" && <div className={`${s.msg} ${s.ok}`} role="status">{message.text}</div>}
          {busy && <div className={`${s.msg} ${s.wait}`}><span className={s.spinner} aria-hidden="true" />Проверяем код…</div>}
        </div>

        <div className={s.fade}>
          {!blocked && (
            <button type="button" className={`btn btn-primary ${s.wide} ${s.confirm}`} disabled={busy || cells.some((c) => !c)} onClick={() => verify(cells.join(""))}>
              {busy ? <><span className={`${s.spinner} ${s.onAccent}`} aria-hidden="true" />Проверяем…</> : "Подтвердить"}
            </button>
          )}
          <ResendTimer seconds={resendIn} restartKey={resendKey} onResend={resend} busy={resending} primary={blocked} label={blocked ? "Отправить новый код" : "Отправить код ещё раз"} />
          {process.env.NEXT_PUBLIC_DATA_MODE !== "live" && api.authMode === "demo" && <div className={s.demo}>Демо: код <b>123456</b></div>}
        </div>

        <div className="sr-only" role="status" aria-live="polite">{live}</div>
        {done && <SuccessCheck title={title} subtitle={result?.user.status === "pending" ? "Доступ ожидает одобрения владельцем" : undefined} />}
      </div>
    </Modal>
  );
}
