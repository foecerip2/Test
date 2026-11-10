"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Play, ShieldAlert } from "lucide-react";
import { api } from "@/lib/api";
import { useResource } from "@/lib/use-resource";
import { useToast } from "@/lib/toast";
import type { ActionPlan } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CheckboxField } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { ErrorState, InlineAlert } from "@/components/ui/states";
import { SkeletonBlock } from "@/components/ui/skeleton";

/** Реальное исполнение подтверждённого плана. Кнопка активна только когда включены ВСЕ выключатели: конфигурация сервера, kill switch
 *  не нажат, организация и сервер. Исполнение происходит один раз на ревизию плана; откат автоматически не выполняется. */
export function ExecutionCard({ plan }: { plan: ActionPlan }) {
  const toast = useToast();
  const router = useRouter();
  const st = useResource(() => api.execution.status(plan.serverId), [plan.serverId]);
  const [open, setOpen] = useState(false);
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const flip = async (what: "org" | "server", enabled: boolean) => {
    const r = what === "org" ? await api.execution.setOrg(enabled) : await api.execution.setServer(plan.serverId, enabled);
    if (!r.ok) toast.push({ tone: "error", title: "Не удалось изменить выключатель", description: r.message });
    void st.reload();
  };
  const run = async () => {
    setBusy(true); setErr(null);
    const r = await api.plans.execute(plan.id);
    setBusy(false);
    if (!r.ok) { setErr(r.message); return; }
    toast.push({ tone: "warning", title: "Исполнение поставлено в очередь", description: "Команды будут выполнены на сервере обёрткой servermind-op." });
    setOpen(false);
    router.push(`/operations/${r.data.id}`);
  };

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle className="flex items-center gap-2"><ShieldAlert aria-hidden className="size-4 text-warning" /> Реальное исполнение на сервере</CardTitle>
          <CardDescription className="mt-1">По умолчанию выключено. Нужны все выключатели и успешная репетиция этой ревизии плана. Исполняется ровно один раз; откат автоматически не выполняется.</CardDescription>
        </div>
        {st.state.status === "ready" && <Badge tone={st.state.data.effective ? "warning" : "neutral"}>{st.state.data.effective ? "Разрешено" : "Выключено"}</Badge>}
      </CardHeader>
      <CardContent className="space-y-4">
        {st.state.status === "loading" && <SkeletonBlock className="h-24 rounded-card" />}
        {st.state.status === "error" && <ErrorState compact code={st.state.code} message={st.state.message} onRetry={st.reload} />}
        {st.state.status === "ready" && (
          <>
            <ul className="divide-y divide-stroke rounded-card border border-stroke text-sm" aria-label="Выключатели исполнения">
              <li className="flex items-center justify-between gap-3 p-3"><span>Конфигурация сервера (EXECUTION_ENABLED)</span><Badge tone={st.state.data.configAllows ? "success" : "danger"}>{st.state.data.configAllows ? "разрешает" : "выключено"}</Badge></li>
              <li className="flex items-center justify-between gap-3 p-3"><span>Kill switch платформы</span><Badge tone={st.state.data.killed ? "danger" : "success"}>{st.state.data.killed ? "нажат" : "не нажат"}</Badge></li>
              <li className="flex items-center justify-between gap-3 p-3"><label htmlFor="exec-org">Организация (владелец)</label><Switch id="exec-org" checked={st.state.data.orgEnabled} onCheckedChange={(v) => void flip("org", v)} /></li>
              <li className="flex items-center justify-between gap-3 p-3"><label htmlFor="exec-server">Этот сервер (владелец)</label><Switch id="exec-server" checked={st.state.data.serverEnabled} onCheckedChange={(v) => void flip("server", v)} /></li>
            </ul>
            <p className="text-xs text-text-muted">Поддерживаются операции: {st.state.data.supportedOperations.join(", ")}. На сервере должна быть установлена обёртка servermind-op (см. docs/operations/target-wrapper.md).</p>
            <Button variant="danger" disabled={!st.state.data.effective} onClick={() => { setErr(null); setUnderstood(false); setOpen(true); }}><Play aria-hidden /> Выполнить на сервере…</Button>
          </>
        )}
      </CardContent>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent title="Выполнить план на сервере?" description="Это изменит сервер. Откат автоматически не выполняется.">
          <div className="space-y-4 p-5 text-sm">
            <p className="text-text-secondary">«{plan.title}» · ревизия {plan.revision}. ServerMind подключится по SSH с закреплённым ключом хоста и вызовет только обёртку servermind-op. Остановится на первой ошибке.</p>
            <CheckboxField checked={understood} onCheckedChange={(v) => setUnderstood(v === true)} label="Понимаю: команды будут выполнены на сервере, повторить исполнение этой ревизии плана нельзя" />
            {err && <InlineAlert tone="danger" title="Не удалось запустить">{err}</InlineAlert>}
          </div>
          <DialogFooter><Button variant="ghost" onClick={() => setOpen(false)}>Отмена</Button><Button variant="danger" loading={busy} disabled={!understood} onClick={() => void run()}>Выполнить</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
