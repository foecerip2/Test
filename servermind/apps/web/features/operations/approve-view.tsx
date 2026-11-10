"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { CircleCheck, FlaskConical, ShieldCheck, ShieldX } from "lucide-react";
import { api } from "@/lib/api";
import { useResource } from "@/lib/use-resource";
import { useToast } from "@/lib/toast";
import { computePlanHash } from "@/lib/plan";
import type { ActionPlan, Operation } from "@/lib/types";
import { PageHeader } from "@/components/layout/page-header";
import { Button, buttonVariants } from "@/components/ui/button";
import { ErrorState, InlineAlert } from "@/components/ui/states";
import { LoadingRegion, SkeletonBlock } from "@/components/ui/skeleton";
import { ActionPlanCard, RiskBanner, useCountdown } from "@/features/operations/action-plan-card";
import { ConfirmActionDialog } from "@/features/operations/confirm-action-dialog";
import { SourceBadge } from "@/features/status";

function ApprovePlan({ plan, operation, reload }: { plan: ActionPlan; operation: Operation | null; reload: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const left = useCountdown(plan.expiresAt);
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busyStep, setBusyStep] = useState<string | null>(null);
  const [rehearsing, setRehearsing] = useState(false);
  const [verified, setVerified] = useState<"pending" | "ok" | "mismatch">("pending");
  const waiting = plan.status === "waiting_approval" && left > 0;

  // Независимая проверка: браузер сам пересчитывает хеш по показанным шагам и сравнивает с хешем сервера.
  useEffect(() => {
    let alive = true;
    setVerified("pending");
    void computePlanHash(plan).then((h) => { if (alive) setVerified(h === plan.canonicalHash ? "ok" : "mismatch"); });
    return () => { alive = false; };
  }, [plan]);

  const toggle = async (stepId: string, enabled: boolean) => {
    setBusyStep(stepId);
    const r = await api.plans.setStepEnabled(plan.id, stepId, enabled);
    setBusyStep(null);
    if (r.ok) toast.push({ tone: "info", title: `План изменён: ревизия ${r.data.revision}`, description: "Хеш пересчитан, прежнее подтверждение недействительно." });
    else toast.push({ tone: "error", title: "Не удалось изменить план", description: r.message });
    reload();
  };

  const confirm = async () => {
    setErr(null);
    const r = await api.plans.approve(plan.id, { hash: plan.canonicalHash, revision: plan.revision });
    if (r.ok) {
      setOpen(false);
      const rec = r.data as { executionAvailable?: boolean; message?: string };
      if (rec.executionAvailable === false || !operation) {
        // Реальный API Фазы 3: согласие записано, исполнитель ещё не подключён — ничего не выполняется
        toast.push({ tone: "info", title: "Подтверждение записано", description: rec.message ?? "Исполнитель ещё не подключён: на сервере ничего не выполнено." });
        reload();
        return;
      }
      toast.push({ tone: "success", title: "Подтверждено", description: "Операция поставлена на выполнение." });
      router.push(`/operations/${operation.id}`);
    } else { setErr(r.message); reload(); }
  };

  // Репетиция: исполнитель перепроверяет план и показывает, что БЫ сделал. На сервере ничего не выполняется.
  const rehearse = async () => {
    setRehearsing(true);
    const r = await api.plans.rehearse(plan.id);
    setRehearsing(false);
    if (r.ok) { toast.push({ tone: "info", title: "Репетиция поставлена в очередь", description: "Проверки без изменений на сервере." }); router.push(`/operations/${r.data.id}`); }
    else toast.push({ tone: "error", title: "Не удалось запустить репетицию", description: r.message });
  };

  const reject = async () => {
    const r = await api.plans.reject(plan.id);
    if (r.ok) {
      toast.push({ tone: "info", title: "План отклонён", description: "Изменения на сервере не вносились." });
      if (operation) router.push(`/operations/${operation.id}`); else reload();
    } else toast.push({ tone: "error", title: "Не удалось отклонить", description: r.message });
  };

  const opHref = operation ? `/operations/${operation.id}` : "/assistant";

  return (
    <>
      <PageHeader
        back={{ href: opHref, label: operation ? "К операции" : "К ассистенту" }}
        title="Подтверждение плана"
        description={<span className="flex flex-wrap items-center gap-2">Проверьте шаги, параметры и риск. Ничего не выполняется до вашего подтверждения. <SourceBadge source={plan.source} /></span>}
      />

      {plan.status === "approved" && (
        <InlineAlert tone="success" title="План уже подтверждён" className="mb-5">
          {operation ? <Link href={`/operations/${operation.id}`} className="text-primary underline">Открыть операцию</Link> : "Согласие записано. Реальное исполнение выключено — на сервере ничего не выполнено. Можно запустить репетицию: все проверки без изменений."}
        </InlineAlert>
      )}
      {plan.status === "rejected" && <InlineAlert tone="info" title="План отклонён" className="mb-5">Изменений на сервере не было.</InlineAlert>}
      {(plan.status === "expired" || (plan.status === "waiting_approval" && left <= 0)) && (
        <InlineAlert tone="warning" title="Срок действия плана истёк" className="mb-5">Подтвердить его нельзя. Попросите ассистента подготовить новый план.</InlineAlert>
      )}
      {verified === "mismatch" && (
        <InlineAlert tone="danger" title="Хеш плана не совпал с пересчитанным в браузере" className="mb-5">Подтверждение заблокировано: данные плана могли быть изменены. Обновите страницу.</InlineAlert>
      )}

      <div className="mx-auto grid max-w-4xl gap-5">
        {waiting && <RiskBanner plan={plan} />}
        <ActionPlanCard plan={plan} editable={waiting} onToggleStep={toggle} busyStep={busyStep} />
        <p className="flex items-center gap-2 text-sm text-text-secondary">
          <CircleCheck aria-hidden className={`size-4 ${verified === "ok" ? "text-success" : "text-text-muted"}`} />
          {verified === "ok" ? "Хеш плана независимо пересчитан в браузере и совпадает с хешем сервера." : verified === "pending" ? "Проверка хеша…" : "Хеш не совпал."}
        </p>
        {waiting && (
          <div className="sticky bottom-0 z-10 -mx-4 flex flex-col-reverse gap-2 border-t border-stroke bg-canvas/95 px-4 py-3 backdrop-blur safe-bottom sm:static sm:mx-0 sm:flex-row sm:justify-end sm:border-0 sm:bg-transparent sm:p-0 sm:backdrop-blur-none">
            <Button variant="secondary" onClick={reject}><ShieldX aria-hidden /> Отклонить</Button>
            <Button disabled={verified !== "ok"} onClick={() => { setErr(null); setOpen(true); }}><ShieldCheck aria-hidden /> Подтвердить…</Button>
          </div>
        )}
        {plan.status === "approved" && !operation && (
          <Button className="w-fit" onClick={rehearse} loading={rehearsing}><FlaskConical aria-hidden /> Запустить репетицию</Button>
        )}
        {!waiting && <Link href={opHref} className={buttonVariants({ variant: "secondary", className: "w-fit" })}>{operation ? "К операции" : "К ассистенту"}</Link>}
      </div>

      <ConfirmActionDialog open={open} onOpenChange={setOpen} plan={plan} onConfirm={confirm} error={err} />
    </>
  );
}

export function ApproveView({ operationId }: { operationId: string }) {
  // Идентификатор вида op_<planId>: план доступен напрямую, а «Операция» (журнал исполнения) появится в Фазе 4
  const derived = operationId.startsWith("op_") ? operationId.slice(3) : null;
  const op = useResource(() => api.operations.get(operationId), [operationId]);
  const planId = derived ?? (op.state.status === "ready" ? op.state.data.planId : null);
  const operation = op.state.status === "ready" ? op.state.data : null;
  const plan = useResource<ActionPlan | null>(
    async () => (planId ? api.plans.get(planId) : { ok: true as const, data: null }),
    [planId],
  );

  if ((!derived && op.state.status === "loading") || (planId && plan.state.status === "loading")) {
    return <LoadingRegion label="Загрузка плана…"><SkeletonBlock className="mb-6 h-14 w-1/2" /><SkeletonBlock className="mx-auto h-96 max-w-4xl rounded-card" /></LoadingRegion>;
  }
  if (!derived && op.state.status === "error") return <ErrorState code={op.state.code} message={op.state.message} onRetry={op.reload} />;
  if (!planId) return <ErrorState code="not_found" message="У этой операции нет плана, требующего подтверждения." />;
  if (plan.state.status === "error") return <ErrorState code={plan.state.code} message={plan.state.message} onRetry={plan.reload} />;
  if (plan.state.status !== "ready" || !plan.state.data) return null;
  return <ApprovePlan plan={plan.state.data} operation={operation} reload={() => { void plan.reload(); void op.reload(); }} />;
}
