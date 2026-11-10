"use client";

import { useEffect, useState } from "react";
import { ClipboardCopy, Clock, Plus, ShieldAlert, ShieldCheck, TriangleAlert } from "lucide-react";
import { planRisk, shortHash } from "@/lib/plan";
import { formatDateTimeUtc } from "@/lib/format";
import { useToast } from "@/lib/toast";
import type { ActionPlan, ParamValue } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { RISK_INFO, RiskBadge } from "@/features/status";
import { cn } from "@/lib/utils";

export function useCountdown(expiresAt: string) {
  const [left, setLeft] = useState(() => Date.parse(expiresAt) - Date.now());
  useEffect(() => {
    const t = setInterval(() => setLeft(Date.parse(expiresAt) - Date.now()), 1000);
    return () => clearInterval(t);
  }, [expiresAt]);
  return left;
}

export function formatLeft(ms: number) {
  if (ms <= 0) return "истёк";
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** RiskBanner: итоговый уровень риска плана и что он означает. */
export function RiskBanner({ plan }: { plan: ActionPlan }) {
  const risk = planRisk(plan);
  const info = RISK_INFO[risk];
  const high = risk === "R3" || risk === "R4" || risk === "R5";
  const Icon = high ? ShieldAlert : risk === "R2" ? TriangleAlert : ShieldCheck;
  return (
    <div
      role="note"
      className={cn(
        "flex items-start gap-3 rounded-card border p-4",
        high ? "border-warning/40 bg-[var(--tint-warning)]" : risk === "R2" ? "border-warning/30 bg-[var(--tint-warning)]" : "border-info/30 bg-[var(--tint-info)]",
      )}
    >
      <Icon aria-hidden className="mt-0.5 size-5 shrink-0 text-warning" />
      <div className="min-w-0">
        <p className="font-medium">Уровень риска плана: {info.label}</p>
        <p className="text-sm text-text-secondary">{info.hint} Время простоя: {plan.downtime}</p>
      </div>
    </div>
  );
}

function ParamTable({ params }: { params: Record<string, ParamValue> }) {
  const entries = Object.entries(params);
  return (
    <dl className="grid grid-cols-1 gap-x-4 gap-y-1 rounded-control border border-stroke bg-canvas p-3 font-mono text-xs sm:grid-cols-[auto_1fr]">
      {entries.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-text-muted">{k}</dt>
          <dd className="break-all text-text-secondary sm:text-right">{String(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ActionPlanCard({
  plan, editable, onToggleStep, busyStep,
}: {
  plan: ActionPlan;
  editable: boolean;
  onToggleStep?: (stepId: string, enabled: boolean) => void;
  busyStep?: string | null;
}) {
  const toast = useToast();
  const left = useCountdown(plan.expiresAt);
  const copyHash = async () => {
    try { await navigator.clipboard.writeText(plan.canonicalHash); toast.push({ tone: "success", title: "Хеш скопирован" }); }
    catch { toast.push({ tone: "error", title: "Не удалось скопировать" }); }
  };

  return (
    <Card>
      <CardHeader>
        <div className="min-w-0">
          <CardTitle>{plan.title}</CardTitle>
          <p className="mt-1 text-sm text-text-secondary">{plan.summary}</p>
        </div>
        <RiskBadge risk={planRisk(plan)} />
      </CardHeader>
      <CardContent className="space-y-6">
        <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
          <div><dt className="label text-text-muted">Сервер</dt><dd className="mt-0.5 font-medium">{plan.serverName}</dd></div>
          <div><dt className="label text-text-muted">Ревизия</dt><dd className="tabular mt-0.5 font-medium">{plan.revision}</dd></div>
          <div>
            <dt className="label text-text-muted">Срок действия</dt>
            <dd className="mt-0.5 flex flex-wrap items-center gap-2 font-medium">
              <Clock aria-hidden className="size-4 text-text-muted" />
              <span className="tabular">{formatDateTimeUtc(plan.expiresAt)}</span>
              <Badge tone={left <= 0 ? "danger" : left < 120_000 ? "warning" : "neutral"}>{left <= 0 ? "истёк" : `осталось ${formatLeft(left)}`}</Badge>
            </dd>
          </div>
          <div><dt className="label text-text-muted">Простой</dt><dd className="mt-0.5">{plan.downtime}</dd></div>
          <div className="sm:col-span-2">
            <dt className="label text-text-muted">SHA-256 плана (подпись подтверждения привязана к нему)</dt>
            <dd className="mt-1 flex items-start gap-2">
              <code className="min-w-0 flex-1 break-all rounded-control border border-stroke bg-canvas px-3 py-2 font-mono text-xs text-text-secondary" title={plan.canonicalHash}>{plan.canonicalHash}</code>
              <Button size="iconSm" variant="secondary" aria-label={`Скопировать хеш ${shortHash(plan.canonicalHash)}`} onClick={copyHash}><ClipboardCopy aria-hidden /></Button>
            </dd>
          </div>
        </dl>

        <section aria-labelledby="steps-title">
          <h3 id="steps-title" className="mb-3">Шаги ({plan.steps.filter((s) => s.enabled).length} из {plan.steps.length} включено)</h3>
          <ol className="space-y-4">
            {plan.steps.map((s, i) => (
              <li key={s.id} className={cn("rounded-card border border-stroke bg-elevated/40 p-4", !s.enabled && "opacity-60")}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium"><span className="tabular mr-2 text-text-muted">{i + 1}.</span>{s.title}</p>
                    <p className="mt-0.5 font-mono text-xs text-text-muted">{s.tool}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <RiskBadge risk={s.risk} />
                    {s.optional && editable && (
                      <label className="flex min-h-11 items-center gap-2 text-sm text-text-secondary">
                        <Switch checked={s.enabled} disabled={busyStep === s.id} onCheckedChange={(v) => onToggleStep?.(s.id, v)} aria-label={`Включить шаг «${s.title}»`} />
                        {s.enabled ? "Включён" : "Выключен"}
                      </label>
                    )}
                    {s.optional && !editable && <Badge>{s.enabled ? "опциональный · включён" : "опциональный · выключен"}</Badge>}
                  </div>
                </div>
                <div className="mt-3 space-y-3">
                  <ParamTable params={s.params} />
                  <div className="space-y-1.5 text-sm">
                    <p className="flex gap-2"><Plus aria-hidden className="mt-0.5 size-4 shrink-0 text-success" /><span><span className="text-text-muted">Что изменится: </span>{s.expectedChange}</span></p>
                    <p className="text-text-secondary"><span className="text-text-muted">Проверка: </span><span className="font-mono text-xs">{s.verify}</span></p>
                    <p className="text-text-secondary"><span className="text-text-muted">Откат: </span>{s.rollback}</p>
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </section>
      </CardContent>
    </Card>
  );
}
