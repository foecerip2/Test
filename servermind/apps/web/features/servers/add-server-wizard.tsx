"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Check, CheckCircle2, ClipboardCopy, Fingerprint, KeyRound, ShieldCheck } from "lucide-react";
import { api } from "@/lib/api";
import { useResource } from "@/lib/use-resource";
import { useToast } from "@/lib/toast";
import { checkHost, checkPort, checkUsername } from "@/lib/validation";
import type { ServerSummary } from "@/lib/types";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CheckboxField } from "@/components/ui/checkbox";
import { Field, Input } from "@/components/ui/input";
import { ErrorState, InlineAlert } from "@/components/ui/states";
import { SkeletonBlock } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const STEPS = ["Данные", "Отпечаток", "Проверка"] as const;
const STORE = "sm.onboarding.server.v1"; // только несекретные поля формы

interface Form { name: string; host: string; port: string; username: string }
const EMPTY: Form = { name: "", host: "", port: "22", username: "servermind" };

function bootstrapScript(key: string, user: string) {
  const u = user || "servermind";
  if (u === "root") {
    // Домашний каталог root — /root (НЕ /home/root). Пользователя создавать не нужно.
    return [
      `# Выполните на VPS от имени root. ServerMind этого не делает.`,
      `install -d -m 700 /root/.ssh`,
      `echo '${key}' >> /root/.ssh/authorized_keys`,
      `chmod 600 /root/.ssh/authorized_keys`,
      `# Вход root по ключу должен быть разрешён: PermitRootLogin prohibit-password (или yes) в /etc/ssh/sshd_config.`,
      `# Проверка: grep -i '^PermitRootLogin' /etc/ssh/sshd_config /etc/ssh/sshd_config.d/*.conf`,
    ].join("\n");
  }
  return [
    `# Выполните на VPS от имени администратора (root или sudo). ServerMind этого не делает.`,
    `adduser --disabled-password --gecos "" ${u}`,
    `install -d -m 700 -o ${u} -g ${u} /home/${u}/.ssh`,
    `echo '${key}' >> /home/${u}/.ssh/authorized_keys`,
    `chown ${u}:${u} /home/${u}/.ssh/authorized_keys && chmod 600 /home/${u}/.ssh/authorized_keys`,
    `# Пользователь не добавляется в группу docker и не получает sudo без пароля.`,
  ].join("\n");
}

export function Stepper({ steps, current }: { steps: readonly string[]; current: number }) {
  return (
    <ol className="mb-6 flex items-center gap-2" aria-label="Шаги подключения">
      {steps.map((label, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <li key={label} className="flex min-w-0 flex-1 items-center gap-2" aria-current={active ? "step" : undefined}>
            <span
              className={cn(
                "grid size-7 shrink-0 place-items-center rounded-full border text-xs font-semibold",
                done ? "border-primary bg-primary text-canvas" : active ? "border-primary text-primary" : "border-stroke text-text-muted",
              )}
            >
              {done ? <Check aria-hidden className="size-4" strokeWidth={3} /> : i + 1}
            </span>
            <span className={cn("hidden truncate text-sm sm:block", active ? "font-medium text-text" : "text-text-muted")}>{label}</span>
            <span className="sr-only">{done ? " — выполнено" : active ? " — текущий шаг" : ""}</span>
            {i < steps.length - 1 && <span aria-hidden className={cn("h-px flex-1", done ? "bg-primary" : "bg-stroke")} />}
          </li>
        );
      })}
    </ol>
  );
}

export function AddServerWizard({ initialStep = 0, onStepChange }: { initialStep?: number; onStepChange?: (s: number) => void }) {
  const toast = useToast();
  const key = useResource(() => api.servers.publicKey(), []);
  const [step, setStepRaw] = useState(initialStep);
  const [form, setForm] = useState<Form>(EMPTY);
  const [errors, setErrors] = useState<Partial<Record<keyof Form, string>>>({});
  const [probe, setProbe] = useState<{ fingerprint: string; keyType: string } | null>(null);
  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [fpConfirmed, setFpConfirmed] = useState(false);
  const [ownerConfirmed, setOwnerConfirmed] = useState(false);
  const [rootRiskAccepted, setRootRiskAccepted] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [created, setCreated] = useState<ServerSummary | null>(null);

  const setStep = (s: number) => { setStepRaw(s); onStepChange?.(s); };

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORE);
      if (raw) setForm({ ...EMPTY, ...(JSON.parse(raw) as Partial<Form>) });
    } catch { /* хранилище недоступно — форма работает без восстановления */ }
  }, []);
  useEffect(() => {
    try { localStorage.setItem(STORE, JSON.stringify(form)); } catch { /* ignore */ }
  }, [form]);

  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setForm((f) => ({ ...f, [k]: e.target.value }));
    setErrors((er) => ({ ...er, [k]: undefined }));
    // смена адреса делает прежнее подтверждение отпечатка и владения недействительным
    if (k === "host" || k === "port") { setProbe(null); setFpConfirmed(false); setOwnerConfirmed(false); setAddError(null); }
  };

  const validate = (): boolean => {
    const next: typeof errors = {};
    const h = checkHost(form.host); if (!h.ok) next.host = h.reason;
    const p = checkPort(form.port); if (!p.ok) next.port = p.reason;
    const u = checkUsername(form.username); if (!u.ok) next.username = u.reason;
    else if (form.username.trim() === "root" && !rootRiskAccepted) next.username = "Подтвердите риск входа под root (галочка ниже) или используйте отдельного пользователя.";
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const copy = async (text: string, what: string) => {
    try { await navigator.clipboard.writeText(text); toast.push({ tone: "success", title: `${what} скопирован` }); }
    catch { toast.push({ tone: "error", title: "Не удалось скопировать", description: "Выделите текст и скопируйте вручную." }); }
  };

  const doProbe = async () => {
    if (!validate()) return;
    setProbing(true); setProbeError(null);
    const p = checkPort(form.port);
    const r = await api.servers.probe({ host: form.host.trim(), port: p.ok ? p.port : 22 });
    setProbing(false);
    if (r.ok) { setProbe({ fingerprint: r.data.fingerprint, keyType: r.data.keyType }); setStep(1); }
    else setProbeError(r.message);
  };

  const doAdd = async () => {
    if (!probe) return;
    setAdding(true); setAddError(null);
    const p = checkPort(form.port);
    const r = await api.servers.add({
      name: form.name.trim() || form.host.trim(), host: form.host.trim(), port: p.ok ? p.port : 22,
      username: form.username.trim(), fingerprint: probe.fingerprint,
      acceptRootRisk: form.username.trim() === "root" && rootRiskAccepted,
    });
    setAdding(false);
    if (r.ok) {
      setCreated(r.data.server);
      try { localStorage.removeItem(STORE); } catch { /* ignore */ }
      toast.push({ tone: "success", title: "Сервер добавлен", description: "Проверка соединения выполнена." });
    } else setAddError(r.message);
  };

  if (created) {
    return (
      <Card className="mx-auto max-w-2xl">
        <CardContent className="flex flex-col items-center gap-4 py-10 text-center">
          <CheckCircle2 aria-hidden className="size-12 text-success" />
          <h2>Сервер подключён</h2>
          <p className="max-w-md text-text-secondary">
            {created.name} · {created.os ?? "ОС не определена"}. Отпечаток ключа сохранён: при его смене подключение будет заблокировано.
            {created.source === "demo" && " (демо-данные: реальное соединение не устанавливалось)"}
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            <Link href={`/servers/${created.id}`} className={buttonVariants()}>Открыть сервер</Link>
            <Link href={`/assistant?server=${created.id}`} className={buttonVariants({ variant: "ai" })}>Спросить AI</Link>
          </div>
        </CardContent>
      </Card>
    );
  }

  const publicKey = key.state.status === "ready" ? key.state.data.key : "";

  return (
    <div className="mx-auto max-w-2xl">
      <Stepper steps={STEPS} current={step} />

      {step === 0 && (
        <div className="space-y-5">
          <Card>
            <CardHeader>
              <div>
                <CardTitle>1. Данные сервера</CardTitle>
                <CardDescription className="mt-1">Нужен Ubuntu VPS и пользователь с SSH-ключом (лучше отдельный; вход под root — только осознанно).</CardDescription>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <Field label="Название (необязательно)" hint="Как сервер будет называться в ServerMind.">
                {(p) => <Input {...p} value={form.name} onChange={set("name")} placeholder="prod-web-1" maxLength={48} />}
              </Field>
              <div className="grid gap-4 sm:grid-cols-[1fr_120px]">
                <Field label="IP-адрес или домен" error={errors.host}>
                  {(p) => <Input {...p} value={form.host} onChange={set("host")} placeholder="203.0.113.10" inputMode="url" autoCapitalize="off" autoCorrect="off" spellCheck={false} />}
                </Field>
                <Field label="Порт SSH" error={errors.port}>
                  {(p) => <Input {...p} value={form.port} onChange={set("port")} inputMode="numeric" />}
                </Field>
              </div>
              <Field label="Пользователь" error={errors.username} hint="Рекомендуется отдельный пользователь. Вход по паролю не используется — только SSH-ключ.">
                {(p) => <Input {...p} value={form.username} onChange={set("username")} autoCapitalize="off" autoCorrect="off" spellCheck={false} />}
              </Field>
              {form.username.trim() === "root" && (
                <div className="space-y-3">
                  <InlineAlert tone="warning" title="Вход под root">
                    Ключ ServerMind получит полный доступ root к серверу. Сейчас ServerMind выполняет только фиксированные команды чтения (ОС, CPU, RAM, диск, службы), а изменения — лишь после вашего подтверждения плана. Ключ можно отозвать в любой момент, удалив строку из /root/.ssh/authorized_keys.
                  </InlineAlert>
                  <CheckboxField checked={rootRiskAccepted} onCheckedChange={(v) => { setRootRiskAccepted(v === true); setErrors((er) => ({ ...er, username: undefined })); }}
                    label="Понимаю риск: ключ ServerMind получит полный доступ root к этому серверу" />
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div>
                <CardTitle className="flex items-center gap-2"><KeyRound aria-hidden className="size-4 text-primary" /> Публичный ключ ServerMind</CardTitle>
                <CardDescription className="mt-1">Добавьте его пользователю на сервере вручную (bootstrap). Приватный ключ не покидает ServerMind.</CardDescription>
              </div>
              {key.state.status === "ready" && key.state.data.source === "demo" && <Badge tone="warning">Демо-ключ, не рабочий</Badge>}
            </CardHeader>
            <CardContent className="space-y-3">
              {key.state.status === "loading" && <SkeletonBlock className="h-20" />}
              {key.state.status === "error" && <ErrorState compact code={key.state.code} message={key.state.message} onRetry={key.reload} />}
              {key.state.status === "ready" && (
                <>
                  <pre tabIndex={0} aria-label="Публичный SSH-ключ ServerMind" className="overflow-x-auto whitespace-pre-wrap break-all rounded-control border border-stroke bg-canvas p-3 font-mono text-xs leading-5 text-text-secondary">{publicKey}</pre>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="secondary" onClick={() => copy(publicKey, "Ключ")}><ClipboardCopy aria-hidden /> Копировать ключ</Button>
                    <Button size="sm" variant="ghost" onClick={() => copy(bootstrapScript(publicKey, form.username.trim()), "Скрипт")}><ClipboardCopy aria-hidden /> Копировать команды bootstrap</Button>
                  </div>
                  <details className="rounded-control border border-stroke bg-canvas p-3 text-sm">
                    <summary className="min-h-8 cursor-pointer font-medium text-text-secondary">Показать команды bootstrap</summary>
                    <pre tabIndex={0} className="mt-3 overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs leading-5 text-text-secondary">{bootstrapScript(publicKey, form.username.trim())}</pre>
                  </details>
                </>
              )}
            </CardContent>
          </Card>

          {probeError && <InlineAlert tone="danger" title="Не удалось получить отпечаток">{probeError}</InlineAlert>}
          {process.env.NEXT_PUBLIC_DEV_FIXTURES === "1" && (
            <InlineAlert tone="warning" title="Демо-сценарии">
              Хост *.invalid — ошибка DNS · порт 9 — соединение отклонено · timeout.* — таймаут · mitm.* — подмена отпечатка · nokey.* — ключ не принят.
            </InlineAlert>
          )}
          <div className="flex justify-end">
            <Button onClick={doProbe} loading={probing}><Fingerprint aria-hidden /> Получить отпечаток сервера</Button>
          </div>
        </div>
      )}

      {step === 1 && probe && (
        <Card>
          <CardHeader>
            <div>
              <CardTitle>2. Сверьте отпечаток сервера</CardTitle>
              <CardDescription className="mt-1">Защита от подмены сервера: подключение возможно только к серверу с этим ключом.</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-control border border-stroke bg-canvas p-4">
              <p className="label text-text-muted">{probe.keyType} · {form.host}:{form.port}</p>
              <p className="mt-1 break-all font-mono text-sm">{probe.fingerprint}</p>
            </div>
            <p className="text-sm text-text-secondary">Выполните на сервере и сравните результат с отпечатком выше:</p>
            <pre tabIndex={0} className="overflow-x-auto rounded-control border border-stroke bg-canvas p-3 font-mono text-xs">ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256</pre>
            <CheckboxField checked={fpConfirmed} onCheckedChange={(v) => setFpConfirmed(v === true)} label="Отпечатки совпадают — это мой сервер" />
            <div className="flex flex-wrap justify-between gap-2">
              <Button variant="ghost" onClick={() => setStep(0)}>Назад</Button>
              <Button disabled={!fpConfirmed} onClick={() => setStep(2)}>Продолжить</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === 2 && probe && (
        <Card>
          <CardHeader>
            <div>
              <CardTitle>3. Проверка соединения</CardTitle>
              <CardDescription className="mt-1">ServerMind подключится по ключу и выполнит только чтение: ОС, CPU, RAM, диск, статус служб.</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-control border border-stroke bg-canvas p-4 text-sm">
              <dt className="text-text-muted">Адрес</dt><dd className="break-all text-right font-mono text-xs">{form.username}@{form.host}:{form.port}</dd>
              <dt className="text-text-muted">Отпечаток</dt><dd className="break-all text-right font-mono text-xs">{probe.fingerprint}</dd>
            </dl>
            {form.username.trim() === "root" ? (
              <InlineAlert tone="warning" title="Доступ root">
                Ключ ServerMind даёт полный доступ root. ServerMind выполняет только фиксированные команды чтения; изменения на сервере — лишь после вашего явного подтверждения плана.
              </InlineAlert>
            ) : (
              <InlineAlert tone="info" title="Права доступа">
                Права только пользователя «{form.username}». Изменения на сервере выполняются лишь после вашего явного подтверждения плана.
              </InlineAlert>
            )}
            <CheckboxField checked={ownerConfirmed} onCheckedChange={(v) => setOwnerConfirmed(v === true)} label="Я владелец этого сервера и разрешаю ServerMind подключаться к нему" />
            {addError && <InlineAlert tone="danger" title="Не удалось добавить сервер">{addError}</InlineAlert>}
            <div className="flex flex-wrap justify-between gap-2">
              <Button variant="ghost" onClick={() => setStep(1)}>Назад</Button>
              <Button disabled={!ownerConfirmed} loading={adding} onClick={doAdd}><ShieldCheck aria-hidden /> Проверить и добавить</Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
