"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, KeyRound, ShieldCheck } from "lucide-react";
import { api } from "@/lib/api";
import { checkEmail } from "@/lib/validation";
import { Logo, LogoMark } from "@/components/layout/logo";
import { DemoRibbon } from "@/components/layout/demo-ribbon";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { SecretInput } from "@/components/ui/secret-input";
import { InlineAlert } from "@/components/ui/states";

export function LoginView() {
  const router = useRouter();
  const [stage, setStage] = useState<"credentials" | "2fa">("credentials");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [errors, setErrors] = useState<{ email?: string; password?: string; code?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submitCredentials = async (e: FormEvent) => {
    e.preventDefault();
    const next: typeof errors = {};
    if (!checkEmail(email)) next.email = "Введите корректный email.";
    if (password.length < 8) next.password = "Пароль — не короче 8 символов.";
    setErrors(next);
    setFormError(null);
    if (Object.keys(next).length) return;
    setBusy(true);
    const r = await api.auth.login(email.trim(), password);
    setBusy(false);
    if (!r.ok) { setFormError(r.message); return; }
    if (r.data.twoFactorRequired) setStage("2fa");
    else router.push("/dashboard");
  };

  const submitCode = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (!/^\d{6}$/.test(code)) { setErrors({ code: "Код состоит из 6 цифр." }); return; }
    setErrors({});
    setBusy(true);
    const r = await api.auth.verify2fa(code);
    setBusy(false);
    if (!r.ok) { setFormError(r.message); return; }
    router.push("/dashboard");
  };

  return (
    <div className="min-h-dvh bg-canvas">
      <DemoRibbon />
      <div className="grid min-h-dvh lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
        <aside className="relative hidden overflow-hidden border-r border-stroke bg-sidebar lg:block">
          <div
            aria-hidden
            className="absolute inset-0 opacity-60"
            style={{
              backgroundImage: "linear-gradient(var(--color-stroke) 1px, transparent 1px), linear-gradient(90deg, var(--color-stroke) 1px, transparent 1px)",
              backgroundSize: "48px 48px",
              maskImage: "radial-gradient(ellipse at 30% 40%, black 10%, transparent 70%)",
              WebkitMaskImage: "radial-gradient(ellipse at 30% 40%, black 10%, transparent 70%)",
            }}
          />
          <div className="relative flex h-full max-w-xl flex-col justify-between p-12">
            <Logo size="lg" />
            <div className="space-y-8">
              <div>
                <h1 className="text-[40px] leading-[48px]">Серверы под контролем.<br /><span className="text-primary">AI рядом.</span></h1>
                <p className="mt-4 max-w-md text-base text-text-secondary">
                  AI-системный администратор для Ubuntu VPS: показывает реальное состояние, предлагает план и действует только с вашего подтверждения.
                </p>
              </div>
              <ul className="space-y-4 text-sm text-text-secondary">
                <li className="flex gap-3"><KeyRound aria-hidden className="mt-0.5 size-5 shrink-0 text-primary" /> Подключение по SSH-ключу. Пароль root не запрашивается.</li>
                <li className="flex gap-3"><ShieldCheck aria-hidden className="mt-0.5 size-5 shrink-0 text-primary" /> AI предлагает план — изменения выполняются только после подтверждения.</li>
              </ul>
            </div>
            <p className="text-xs text-text-muted">ServerMind · закрытая бета</p>
          </div>
        </aside>

        <main className="flex items-center justify-center px-5 py-10 sm:px-10">
          <div className="w-full max-w-sm">
            <div className="mb-8 flex items-center gap-3 lg:hidden"><LogoMark className="size-9" /><Logo size="lg" className="[&>svg]:hidden" /></div>

            {stage === "credentials" ? (
              <form onSubmit={submitCredentials} noValidate className="space-y-5" aria-labelledby="login-title">
                <div>
                  <h2 id="login-title" className="text-[26px] leading-8">Вход</h2>
                  <p className="mt-1 text-sm text-text-secondary">Закрытая бета: аккаунты создаются по приглашению владельца.</p>
                </div>
                <Field label="Email" error={errors.email}>
                  {(p) => <Input {...p} type="email" autoComplete="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />}
                </Field>
                <Field label="Пароль" error={errors.password}>
                  {(p) => <SecretInput {...p} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className="font-sans" />}
                </Field>
                {formError && <InlineAlert tone="danger" title="Не удалось войти">{formError}</InlineAlert>}
                {process.env.NEXT_PUBLIC_DEV_FIXTURES === "1" && <InlineAlert tone="warning" title="Демо-вход">Проверки нет: подойдёт любой email и пароль от 8 символов, затем 6 цифр кода. Реальная аутентификация — Фаза 2.</InlineAlert>}
                <Button type="submit" className="w-full" loading={busy}>Войти <ArrowRight aria-hidden /></Button>
                <p className="text-center text-sm text-text-muted">Нет приглашения? Обратитесь к владельцу пространства.</p>
              </form>
            ) : (
              <form onSubmit={submitCode} noValidate className="space-y-5" aria-labelledby="tfa-title">
                <div>
                  <h2 id="tfa-title" className="text-[26px] leading-8">Код подтверждения</h2>
                  <p className="mt-1 text-sm text-text-secondary">Введите 6-значный код из приложения-аутентификатора.</p>
                </div>
                <Field label="Код" error={errors.code}>
                  {(p) => <Input {...p} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" autoFocus className="text-center font-mono text-lg tracking-[0.4em]" placeholder="000000" />}
                </Field>
                {formError && <InlineAlert tone="danger" title="Код не принят">{formError}</InlineAlert>}
                <Button type="submit" className="w-full" loading={busy}>Подтвердить</Button>
                <Button type="button" variant="ghost" className="w-full" onClick={() => { setStage("credentials"); setCode(""); setFormError(null); }}>Назад</Button>
              </form>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
