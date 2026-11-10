"use client";

import Link from "next/link";
import { useState } from "react";
import { Ban, ShieldQuestion } from "lucide-react";
import { api } from "@/lib/api";
import { useResource } from "@/lib/use-resource";
import { useToast } from "@/lib/toast";
import { formatDateTimeUtc } from "@/lib/format";
import { PageHeader } from "@/components/layout/page-header";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ErrorState, InlineAlert } from "@/components/ui/states";
import { LoadingRegion, SkeletonBlock } from "@/components/ui/skeleton";
import { JobStatusBadge, RiskBadge, SourceBadge } from "@/features/status";
import { EventLog } from "@/features/operations/event-log";
import { ExecutionProgress } from "@/features/operations/execution-progress";

export function OperationDetailView({ id }: { id: string }) {
  const op = useResource(() => api.operations.get(id), [id], { pollMs: 3000 });
  const planId = op.state.status === "ready" ? op.state.data.planId : null;
  const plan = useResource<import("@/lib/types").ActionPlan | null>(
    async () => (planId ? api.plans.get(planId) : { ok: true as const, data: null }),
    [planId],
  );
  const toast = useToast();
  const [cancelling, setCancelling] = useState(false);

  if (op.state.status === "loading") {
    return <LoadingRegion label="Загрузка операции…"><SkeletonBlock className="mb-6 h-14 w-1/2" /><SkeletonBlock className="h-64 rounded-card" /></LoadingRegion>;
  }
  if (op.state.status === "error") return <ErrorState code={op.state.code} message={op.state.message} onRetry={op.reload} />;

  const o = op.state.data;
  const rehearsal = o.mode === "rehearsal";
  const active = o.status === "running" || o.status === "queued" || o.status === "validating" || o.status === "waiting_approval";

  const cancel = async () => {
    setCancelling(true);
    const r = await api.operations.cancel(id);
    setCancelling(false);
    toast.push(r.ok ? { tone: "info", title: "Операция отменена", description: "Отмена не равнозначна откату." } : { tone: "error", title: "Не удалось отменить", description: r.message });
    void op.reload();
  };

  return (
    <>
      <PageHeader
        back={{ href: "/operations", label: "Операции" }}
        title={o.title}
        description={<span className="flex flex-wrap items-center gap-2"><JobStatusBadge status={o.status} /><RiskBadge risk={o.risk} /><SourceBadge source={o.source} /></span>}
        actions={
          <>
            {o.status === "waiting_approval" && o.planId && (
              <Link href={`/operations/${o.id}/approve`} className={buttonVariants()}><ShieldQuestion aria-hidden /> Проверить и подтвердить</Link>
            )}
            {active && !rehearsal && <Button variant="secondary" onClick={cancel} loading={cancelling}><Ban aria-hidden /> Отменить</Button>}
          </>
        }
      />

      {rehearsal && (
        <InlineAlert tone="info" title="Это репетиция" className="mb-5">
          Исполнитель выполнил все проверки и показал, что БЫ сделал. На сервере ничего не выполнялось и не изменялось.
          {o.status === "blocked" && " Репетиция остановлена проверкой: причина указана в журнале ниже."}
        </InlineAlert>
      )}
      {(o.status === "failed" || o.status === "cancelled") && !rehearsal && (
        <InlineAlert tone="warning" title="Откат не выполнялся автоматически" className="mb-5">
          Уже выполненные шаги не отменяются. Проверьте состояние сервера и журнал ниже; при необходимости подготовьте новый план.
        </InlineAlert>
      )}
      {o.status === "expired" && (
        <InlineAlert tone="info" title="Срок действия плана истёк" className="mb-5">Ничего не выполнялось. Попросите ассистента подготовить план заново.</InlineAlert>
      )}

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5">
          <Card>
            <CardHeader><CardTitle>Сведения</CardTitle></CardHeader>
            <CardContent>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                <dt className="text-text-muted">Сервер</dt><dd className="text-right"><Link className="hover:text-primary" href={`/servers/${o.serverId}`}>{o.serverName}</Link></dd>
                <dt className="text-text-muted">Автор</dt><dd className="text-right">{o.actor}</dd>
                <dt className="text-text-muted">Создана</dt><dd className="tabular text-right">{formatDateTimeUtc(o.createdAt)}</dd>
                <dt className="text-text-muted">Запущена</dt><dd className="tabular text-right">{formatDateTimeUtc(o.startedAt)}</dd>
                <dt className="text-text-muted">Завершена</dt><dd className="tabular text-right">{formatDateTimeUtc(o.finishedAt)}</dd>
                {plan.state.status === "ready" && plan.state.data && (
                  <><dt className="text-text-muted">Ревизия плана</dt><dd className="tabular text-right">{plan.state.data.revision}</dd></>
                )}
              </dl>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Выполнение</CardTitle></CardHeader>
            <CardContent>
              {o.stepsTotal === 0 ? <p className="text-sm text-text-muted">Шагов нет.</p> : <ExecutionProgress operation={o} plan={plan.state.status === "ready" ? plan.state.data : null} />}
            </CardContent>
          </Card>
        </div>
        <Card className="lg:col-span-2">
          <CardHeader><CardTitle>Журнал событий</CardTitle></CardHeader>
          <CardContent>
            <EventLog events={o.events} />
            <p className="mt-3 text-xs text-text-muted">Секреты скрыты до записи в журнал. Все времена — UTC.</p>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
