"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { LogOut, ShieldCheck, Smartphone, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { useResource } from "@/lib/use-resource";
import { useToast } from "@/lib/toast";
import { relativeTime } from "@/lib/format";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/input";
import { ErrorState } from "@/components/ui/states";
import { SkeletonBlock } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { ServerPicker } from "@/features/servers/server-picker";

function SettingRow({ title, description, children, id }: { title: string; description: string; children: ReactNode; id: string }) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div className="min-w-0"><label htmlFor={id} className="font-medium">{title}</label><p className="text-sm text-text-secondary">{description}</p></div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export function SettingsView() {
  const router = useRouter();
  const toast = useToast();
  const me = useResource(() => api.auth.me(), []);
  const sessions = useResource(() => api.settings.sessions(), []);
  const policy = useResource(() => api.settings.policy(), []);
  const servers = useResource(() => api.servers.list(), []);
  const [delOpen, setDelOpen] = useState(false);
  const [delServer, setDelServer] = useState("");
  const [delBusy, setDelBusy] = useState(false);

  const list = servers.state.status === "ready" ? servers.state.data : [];
  const target = delServer || list[0]?.id || "";

  const savePolicy = async (p: Parameters<typeof api.settings.setPolicy>[0]) => {
    const r = await api.settings.setPolicy(p);
    toast.push(r.ok ? { tone: "success", title: "Политика сохранена" } : { tone: "error", title: "Не удалось сохранить", description: r.message });
    void policy.reload();
  };
  const revoke = async (id: string) => {
    const r = await api.settings.revokeSession(id);
    toast.push(r.ok ? { tone: "info", title: "Сессия завершена" } : { tone: "error", title: "Не удалось завершить", description: r.message });
    void sessions.reload();
  };
  const deleteSecrets = async () => {
    setDelBusy(true);
    const r = await api.settings.deleteServerSecrets(target);
    setDelBusy(false);
    toast.push(r.ok ? { tone: "success", title: "Секреты сервера удалены", description: "Сервер отключён от ServerMind." } : { tone: "error", title: "Не удалось удалить", description: r.message });
    if (r.ok) { setDelOpen(false); void servers.reload(); }
  };
  const logout = async () => { await api.auth.logout(); router.push("/login"); };

  return (
    <>
      <PageHeader title="Настройки" description="Аккаунт, безопасность и политика подтверждений." />
      <div className="grid max-w-3xl gap-6">
        <Card>
          <CardHeader><CardTitle>Профиль</CardTitle></CardHeader>
          <CardContent>
            {me.state.status === "loading" && <SkeletonBlock className="h-24" />}
            {me.state.status === "error" && <ErrorState compact code={me.state.code} message={me.state.message} onRetry={me.reload} />}
            {me.state.status === "ready" && (
              <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-3 text-sm">
                <dt className="text-text-muted">Имя</dt><dd className="text-right">{me.state.data.name}</dd>
                <dt className="text-text-muted">Email</dt><dd className="break-all text-right">{me.state.data.email}</dd>
                <dt className="text-text-muted">Роль</dt><dd className="text-right">{me.state.data.role === "owner" ? "Владелец" : me.state.data.role === "operator" ? "Оператор" : "Наблюдатель"}</dd>
                <dt className="text-text-muted">Пространство</dt><dd className="text-right">{me.state.data.workspace}</dd>
              </dl>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><div><CardTitle className="flex items-center gap-2"><ShieldCheck aria-hidden className="size-4 text-primary" /> Безопасность</CardTitle><CardDescription className="mt-1">Двухфакторная аутентификация обязательна для владельцев и операторов.</CardDescription></div></CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span>2FA</span>
              {me.state.status === "ready" ? <Badge tone={me.state.data.twoFactorEnabled ? "success" : "warning"}>{me.state.data.twoFactorEnabled ? "Включена" : "Выключена"}</Badge> : <Badge>нет данных</Badge>}
            </div>
            <div className="border-t border-stroke pt-4">
              <h3 className="mb-2">Активные сессии</h3>
              {sessions.state.status === "loading" && <SkeletonBlock className="h-20" />}
              {sessions.state.status === "error" && <ErrorState compact code={sessions.state.code} message={sessions.state.message} onRetry={sessions.reload} />}
              {sessions.state.status === "ready" && (
                <ul className="divide-y divide-stroke">
                  {sessions.state.data.map((s) => (
                    <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
                      <span className="flex min-w-0 items-center gap-3"><Smartphone aria-hidden className="size-4 shrink-0 text-text-muted" /><span className="min-w-0"><span className="block truncate font-medium">{s.device}</span><span className="block text-xs text-text-muted">активность {relativeTime(s.lastActiveAt)}</span></span></span>
                      {s.current ? <Badge tone="primary">Текущая</Badge> : <Button size="sm" variant="secondary" onClick={() => void revoke(s.id)}>Завершить</Button>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><div><CardTitle>Политика подтверждений</CardTitle><CardDescription className="mt-1">Операции, изменяющие сервер, всегда требуют явного подтверждения — отключить это нельзя.</CardDescription></div></CardHeader>
          <CardContent>
            {policy.state.status === "loading" && <SkeletonBlock className="h-32" />}
            {policy.state.status === "error" && <ErrorState compact code={policy.state.code} message={policy.state.message} onRetry={policy.reload} />}
            {policy.state.status === "ready" && (
              <div className="divide-y divide-stroke">
                <SettingRow id="r2" title="Подтверждать R2 (изменение службы)" description="Всегда включено."><Switch id="r2" checked disabled aria-label="Подтверждать R2" /></SettingRow>
                <SettingRow id="r3" title="Подтверждать R3 (системные изменения)" description="Всегда включено."><Switch id="r3" checked disabled aria-label="Подтверждать R3" /></SettingRow>
                <div className="grid gap-4 py-4 sm:grid-cols-2">
                  <Field label="Срок действия плана">
                    {(p) => (
                      <Select {...p} value={policy.state.status === "ready" ? policy.state.data.planTtlMinutes : 15} onChange={(e) => void savePolicy({ planTtlMinutes: Number(e.target.value) })}>
                        {[5, 15, 30, 60].map((m) => <option key={m} value={m}>{m} минут</option>)}
                      </Select>
                    )}
                  </Field>
                  <Field label="Лимит операций в сутки" hint="От 1 до 100.">
                    {(p) => (
                      <Input {...p} type="number" min={1} max={100} defaultValue={policy.state.status === "ready" ? policy.state.data.maxOperationsPerDay : 20}
                        onBlur={(e) => { const n = Number(e.target.value); if (Number.isInteger(n) && n >= 1 && n <= 100) void savePolicy({ maxOperationsPerDay: n }); }} />
                    )}
                  </Field>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Уведомления</CardTitle></CardHeader>
          <CardContent>
            <SettingRow id="tg" title="Telegram-алерты" description="Уведомления о недоступности сервера и ожидающих подтверждениях."><span className="flex items-center gap-3"><Badge>Скоро</Badge><Switch id="tg" disabled aria-label="Telegram-алерты" /></span></SettingRow>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><div><CardTitle>Данные</CardTitle><CardDescription className="mt-1">Удаление сохранённых SSH-реквизитов сервера. Сервер перестанет управляться ServerMind.</CardDescription></div></CardHeader>
          <CardContent className="flex flex-wrap items-center gap-3">
            <Button variant="secondary" disabled={list.length === 0} onClick={() => setDelOpen(true)}><Trash2 aria-hidden /> Удалить секреты сервера…</Button>
            {list.length === 0 && <span className="text-sm text-text-muted">Нет подключённых серверов.</span>}
          </CardContent>
        </Card>

        <div><Button variant="outline" onClick={logout}><LogOut aria-hidden /> Выйти</Button></div>
      </div>

      <Dialog open={delOpen} onOpenChange={setDelOpen}>
        <DialogContent title="Удалить секреты сервера?" description="Действие необратимо: для повторного подключения понадобится пройти онбординг заново.">
          <div className="space-y-4 p-5">
            <Field label="Сервер">{(p) => <ServerPicker id={p.id} servers={list} value={target} onChange={setDelServer} />}</Field>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDelOpen(false)}>Отмена</Button>
            <Button variant="danger" loading={delBusy} onClick={deleteSecrets}>Удалить</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
