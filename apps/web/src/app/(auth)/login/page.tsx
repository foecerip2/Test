"use client";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { CodeDialog } from "@/components/auth/CodeDialog";
import { EmailStep } from "@/components/auth/EmailStep";
import { ApiError, getApi, type OtpChallenge } from "@/lib/api";
import { authErrorText, isValidEmail } from "@/lib/auth";
import { useDocumentTitle } from "@/lib/hooks";
import s from "./login.module.css";

export default function LoginPage() {
  useDocumentTitle("Вход");
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [challenge, setChallenge] = useState<OtpChallenge | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const demo = getApi().authMode === "mock";

  // Уже вошли — сразу в рабочее пространство.
  useEffect(() => { getApi().auth.me().then((u) => { if (u) router.replace("/overview"); }, () => undefined); }, [router]);
  // На десктопе сразу ставим курсор в поле; на телефоне не открываем клавиатуру без запроса.
  useEffect(() => { if (window.matchMedia?.("(pointer: fine)").matches) emailRef.current?.focus(); }, []);

  async function submit() {
    const value = email.trim();
    if (!isValidEmail(value)) { setError(authErrorText("INVALID_EMAIL")); emailRef.current?.focus(); return; }
    setBusy(true); setError(null);
    try { setChallenge(await getApi().auth.requestCode(value)); }
    catch (x) { setError(authErrorText(x instanceof ApiError ? x.code : "UNKNOWN", x instanceof ApiError ? x.details.retryAfter : undefined)); }
    setBusy(false);
  }

  const done = useCallback(() => { router.replace("/overview"); }, [router]);
  // Кнопка отправки на момент открытия окна заблокирована (busy), поэтому фокус возвращаем в поле email сами.
  const closeDialog = () => { setChallenge(null); requestAnimationFrame(() => emailRef.current?.focus()); };
  const changeEmail = () => { setChallenge(null); requestAnimationFrame(() => { emailRef.current?.focus(); emailRef.current?.select(); }); };

  return (
    <>
      <main className={s.wrap} inert={challenge ? true : undefined}>
        <div className={s.card}>
          <div className="brand" style={{ padding: "0 0 22px" }}>
            <div className="brand-mark" aria-hidden="true"><span /><span /><span /><span /></div>
            <div><div className="brand-name">leadhunter<span className="brand-dot">.</span></div><div className="brand-sub" lang="en">PRIVATE WORKSPACE</div></div>
          </div>
          <h1 className={s.title}>Войти или создать аккаунт</h1>
          <p className="subtitle" style={{ marginBottom: 22 }}>Отправим 6-значный код на вашу почту. Пароль не нужен.</p>
          <EmailStep value={email} onChange={(v) => { setEmail(v); if (error) setError(null); }} onSubmit={submit} busy={busy} error={error} demo={demo} inputRef={emailRef} />
          <p className={s.foot}>Если аккаунта ещё нет, он будет создан после подтверждения почты.</p>
        </div>
      </main>
      {challenge && <CodeDialog email={email.trim()} challenge={challenge} onClose={closeDialog} onChangeEmail={changeEmail} onDone={done} />}
    </>
  );
}
