"use client";

import { useRef, useState } from "react";
import { Copy, Plus, PowerOff } from "lucide-react";
import { api } from "@/lib/api";
import { useResource } from "@/lib/use-resource";
import { useToast } from "@/lib/toast";
import { formatDateTimeUtc } from "@/lib/format";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/input";
import { ErrorState, InlineAlert } from "@/components/ui/states";
import { SkeletonBlock } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { AiProvidersCard } from "./ai-providers-card";
import { checkEmail } from "@/lib/validation";
import { PlatformModelsCard } from "@/features/admin/platform-models-card";

export function AdminView() {
  const toast = useToast();
  const me = useResource(() => api.auth.me(), []);
  const invites = useResource(() => api.admin.invites(), []);
  const audit = useResource(() => api.admin.audit(), []);
  const flags = useResource(() => api.admin.flags(), []);
  const kill = useResource(() => api.admin.killSwitch(), []);

  const [creditOpen, setCreditOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [amount, setAmount] = useState("100");
  const [reason, setReason] = useState("");
  const [creditErr, setCreditErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [killOpen, setKillOpen] = useState(false);
  const idemKey = useRef<string>(crypto.randomUUID()); // один ключ на попытку выдачи; обновляется после успеха

  if (me.state.status === "loading") return <SkeletonBlock className="h-64 rounded-card" />;
  if (me.state.status === "error") return <ErrorState code={me.state.code} message={me.state.message} onRetry={me.reload} />;
  if (me.state.data.role !== "owner") return <ErrorState code="forbidden" message="Раздел доступен только владельцу. Доступ проверяется на сервере." />;

  const execEnabled = kill.state.status === "ready" ? kill.state.data.executionEnabled : null;

  const issue = async () => {
    setCreditErr(null);
    if (!checkEmail(email)) { setCreditErr("Укажите корректный email пользователя."); return; }
    setBusy(true);
    const r = await api.admin.issueCredits({ email: email.trim(), amount: Number(amount), reason, idempotencyKey: idemKey.current });
    setBusy(false);
    if (!r.ok) { setCreditErr(r.message); return; }
    toast.push({ tone: "success", title: "Тестовые кредиты выданы", description: "Операция записана в аудит." });
    idemKey.current = crypto.randomUUID();
    setCreditOpen(false); setReason(""); void audit.reload();
  };
  const setKill = async (enabled: boolean) => {
    const r = await api.admin.setKillSwitch(enabled);
    toast.push(r.ok ? { tone: enabled ? "success" : "warning", title: enabled ? "Исполнение включено" : "Исполнение остановлено", description: enabled ? undefined : "Новые задания не запускаются; текущие отменяются по возможности." } : { tone: "error", title: "Не удалось изменить", description: r.message });
    setKillOpen(false); void kill.reload(); void audit.reload();
  };
  const copy = async (text: string) => { try { await navigator.clipboard.writeText(text); toast.push({ tone: "success", title: "Код скопирован" }); } catch { toast.push({ tone: "error", title: "Не удалось скопировать" }); } };

  return (
    <>
      <PageHeader title="Админка" description="Подключение AI, приглашения, тестовые кредиты и управление платформой." />
      <div className="grid gap-6 xl:grid-cols-2">
        <AiProvidersCard />
        <Card className="xl:col-span-2">
          <CardHeader>
            <div><CardTitle className="flex items-center gap-2"><PowerOff aria-hidden className="size-4 text-danger" /> Аварийная остановка исполнения (kill switch)</CardTitle><CardDescription className="mt-1">Останавливает запуск новых заданий на уровне backend и worker. Отмена текущих — best-effort.</CardDescription></div>
            {execEnabled != null && <Badge tone={execEnabled ? "success" : "danger"}>{execEnabled ? "Исполнение включено" : "Исполнение ОСТАНОВЛЕНО"}</Badge>}
          </CardHeader>
          <CardContent>
            {kill.state.status === "loading" && <SkeletonBlock className="h-10 w-48" />}
            {kill.state.status === "error" && <ErrorState compact code={kill.state.code} message={kill.state.message} onRetry={kill.reload} />}
            {execEnabled != null && (execEnabled
              ? <Button variant="danger" onClick={() => setKillOpen(true)}><PowerOff aria-hidden /> Остановить исполнение</Button>
              : <Button onClick={() => void setKill(true)}>Возобновить исполнение</Button>)}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Приглашения</CardTitle>
            <Button size="sm" onClick={async () => { const r = await api.admin.createInvite(); toast.push(r.ok ? { tone: "success", title: "Код создан" } : { tone: "error", title: "Не удалось создать", description: r.message }); void invites.reload(); void audit.reload(); }}><Plus aria-hidden /> Создать код</Button>
          </CardHeader>
          <CardContent>
            {invites.state.status === "loading" && <SkeletonBlock className="h-20" />}
            {invites.state.status === "error" && <ErrorState compact code={invites.state.code} message={invites.state.message} onRetry={invites.reload} />}
            {invites.state.status === "ready" && invites.state.data.length === 0 && <p className="text-sm text-text-muted">Активных приглашений нет.</p>}
            {invites.state.status === "ready" && (
              <ul className="divide-y divide-stroke">
                {invites.state.data.map((i) => (
                  <li key={i.code} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span><code className="font-mono text-sm">{i.code}</code><span className="block text-xs text-text-muted">до {formatDateTimeUtc(i.expiresAt)} · {i.usedBy ? `использован: ${i.usedBy}` : "не использован"}</span></span>
                    <Button size="iconSm" variant="ghost" aria-label={`Копировать код ${i.code}`} onClick={() => void copy(i.code)}><Copy aria-hidden /></Button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <PlatformModelsCard />

        <Card>
          <CardHeader><CardTitle>Тестовые кредиты</CardTitle><Button size="sm" variant="secondary" onClick={() => setCreditOpen(true)}>Выдать…</Button></CardHeader>
          <CardContent className="space-y-2 text-sm text-text-secondary">
            <p>Начисление создаёт запись в ledger и в аудите с указанием причины. Автоматическая оплата не подключена.</p>
            <p className="text-text-muted">Отключение пользователя и лимиты на пользователя — запланированы (Фаза 5).</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Флаги функций</CardTitle></CardHeader>
          <CardContent>
            {flags.state.status === "loading" && <SkeletonBlock className="h-24" />}
            {flags.state.status === "error" && <ErrorState compact code={flags.state.code} message={flags.state.message} onRetry={flags.reload} />}
            {flags.state.status === "ready" && (
              <ul className="divide-y divide-stroke">
                {flags.state.data.map((f) => (
                  <li key={f.key} className="flex items-center justify-between gap-4 py-3">
                    <label htmlFor={`flag-${f.key}`} className="min-w-0"><span className="block font-medium">{f.label}</span><span className="block text-sm text-text-secondary">{f.description}</span></label>
                    <Switch id={`flag-${f.key}`} checked={f.enabled} onCheckedChange={async (v) => { await api.admin.setFlag(f.key, v); void flags.reload(); void audit.reload(); }} />
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Аудит (только чтение)</CardTitle></CardHeader>
          <CardContent>
            {audit.state.status === "loading" && <SkeletonBlock className="h-32" />}
            {audit.state.status === "error" && <ErrorState compact code={audit.state.code} message={audit.state.message} onRetry={audit.reload} />}
            {audit.state.status === "ready" && audit.state.data.length === 0 && <p className="text-sm text-text-muted">Событий нет.</p>}
            {audit.state.status === "ready" && (
              <ol className="max-h-80 space-y-2 overflow-y-auto">
                {audit.state.data.map((a) => (
                  <li key={a.id} className="rounded-control border border-stroke bg-canvas px-3 py-2 text-sm">
                    <p className="flex flex-wrap items-center justify-between gap-2"><code className="font-mono text-xs text-primary">{a.action}</code><time dateTime={a.at} className="tabular text-xs text-text-muted">{formatDateTimeUtc(a.at)}</time></p>
                    <p className="text-text-secondary">{a.actor} → {a.target}</p>
                  </li>
                ))}
              </ol>
            )}
          </CardContent>
        </Card>
      </div>

      <Dialog open={creditOpen} onOpenChange={setCreditOpen}>
        <DialogContent title="Выдать тестовые кредиты" description="Запись попадёт в ledger и аудит.">
          <form onSubmit={(e) => { e.preventDefault(); void issue(); }} className="space-y-4 p-5">
            <Field label="Email пользователя">{(p) => <Input {...p} type="email" value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
            <Field label="Количество кредитов" hint="Целое число от 1 до 10 000.">{(p) => <Input {...p} inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/\D/g, ""))} />}</Field>
            <Field label="Причина (для аудита)">{(p) => <Input {...p} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Тестирование деплоя" />}</Field>
            {creditErr && <InlineAlert tone="danger">{creditErr}</InlineAlert>}
            <DialogFooter className="-mx-5 -mb-5 mt-2"><Button type="button" variant="ghost" onClick={() => setCreditOpen(false)}>Отмена</Button><Button type="submit" loading={busy}>Выдать</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={killOpen} onOpenChange={setKillOpen}>
        <DialogContent title="Остановить исполнение?" description="Новые задания перестанут запускаться на всех серверах.">
          <div className="p-5 text-sm text-text-secondary">Текущие задания будут отменены по возможности; отмена не равнозначна откату. Возобновить можно в любой момент.</div>
          <DialogFooter><Button variant="ghost" onClick={() => setKillOpen(false)}>Отмена</Button><Button variant="danger" onClick={() => void setKill(false)}>Остановить</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
