"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { api } from "@/lib/api";
import { checkEmail } from "@/lib/validation";
import { Logo } from "@/components/layout/logo";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { SecretInput } from "@/components/ui/secret-input";
import { InlineAlert } from "@/components/ui/states";

/** Регистрация по пригласительному коду закрытой беты. После создания аккаунта — вход и обязательная настройка 2FA. */
export function RegisterView() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [invite, setInvite] = useState("");
  const [errors, setErrors] = useState<{ email?: string; password?: string; invite?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const next: typeof errors = {};
    if (!checkEmail(email)) next.email = "Введите корректный email.";
    if (password.length < 12) next.password = "Пароль — не короче 12 символов.";
    if (invite.trim().length < 8) next.invite = "Введите код приглашения.";
    setErrors(next);
    setFormError(null);
    if (Object.keys(next).length) return;
    setBusy(true);
    const r = await api.auth.register({ email: email.trim(), password, inviteCode: invite.trim(), name: name.trim() });
    setBusy(false);
    if (!r.ok) { setFormError(r.message); return; }
    router.push("/login?registered=1");
  };

  return (
    <div className="flex min-h-dvh items-center justify-center bg-canvas px-5 py-10">
      <form onSubmit={submit} noValidate className="w-full max-w-sm space-y-5" aria-labelledby="register-title">
        <Logo size="lg" />
        <div>
          <h1 id="register-title" className="text-[26px] leading-8">Регистрация по приглашению</h1>
          <p className="mt-1 text-sm text-text-secondary">Закрытая бета. Код приглашения выдаёт администратор платформы. После регистрации потребуется настроить 2FA.</p>
        </div>
        <Field label="Код приглашения" error={errors.invite}>
          {(p) => <Input {...p} value={invite} onChange={(e) => setInvite(e.target.value)} autoCapitalize="off" autoCorrect="off" spellCheck={false} />}
        </Field>
        <Field label="Email" error={errors.email}>
          {(p) => <Input {...p} type="email" autoComplete="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />}
        </Field>
        <Field label="Имя (необязательно)">
          {(p) => <Input {...p} autoComplete="name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />}
        </Field>
        <Field label="Пароль" error={errors.password} hint="Не короче 12 символов.">
          {(p) => <SecretInput {...p} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} className="font-sans" />}
        </Field>
        {formError && <InlineAlert tone="danger" title="Не удалось зарегистрироваться">{formError}</InlineAlert>}
        <Button type="submit" className="w-full" loading={busy}>Создать аккаунт <ArrowRight aria-hidden /></Button>
        <p className="text-center text-sm text-text-muted">Уже есть аккаунт? <Link href="/login" className="text-primary underline">Войти</Link></p>
      </form>
    </div>
  );
}
