"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Field, Notice } from "@/components/ui";
import { ApiError, getApi } from "@/lib/api";
import { useDocumentTitle } from "@/lib/hooks";
import s from "./login.module.css";

export default function LoginPage() {
  useDocumentTitle("Вход");
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mock = getApi().mode === "mock";

  useEffect(() => { getApi().auth.me().then((m) => { if (m) router.replace("/overview"); }); }, [router]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try { await getApi().auth.login(email.trim(), password); router.replace("/overview"); }
    catch (x) { setErr(x instanceof ApiError ? x.message : "Не удалось войти. Повторите попытку."); setBusy(false); }
  }

  return (
    <main className={s.wrap}>
      <div className={s.card}>
        <div className="brand" style={{ padding: "0 0 22px" }}>
          <div className="brand-mark" aria-hidden="true"><span /><span /><span /><span /></div>
          <div><div className="brand-name">leadhunter<span className="brand-dot">.</span></div><div className="brand-sub">PRIVATE WORKSPACE</div></div>
        </div>
        <h1 className={s.title}>Вход в рабочее пространство</h1>
        <p className="subtitle" style={{ marginBottom: 22 }}>Доступ только для владельца.</p>
        {mock && <div style={{ marginBottom: 18 }}><Notice tone="info" icon="info">Демо-режим: подойдёт любой email и пароль от 8 символов. Данные вымышленные, отправки нет.</Notice></div>}
        <form onSubmit={submit} noValidate>
          <Field label="Email" htmlFor="email">
            <input id="email" className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required aria-invalid={!!err} />
          </Field>
          <Field label="Пароль" htmlFor="password" error={err}>
            <input id="password" className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required aria-invalid={!!err} aria-describedby={err ? "password-err" : undefined} />
          </Field>
          <button className="btn btn-primary" style={{ width: "100%" }} disabled={busy || !email || !password}>{busy ? "Входим…" : "Войти"}</button>
        </form>
      </div>
    </main>
  );
}
