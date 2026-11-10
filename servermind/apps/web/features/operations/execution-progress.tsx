import { CheckCircle2, Circle, CircleSlash, Loader2, XCircle } from "lucide-react";
import type { ActionPlan, Operation } from "@/lib/types";
import { ProgressBar } from "@/components/ui/meter";
import { cn } from "@/lib/utils";

/**
 * Прогресс выполнения. Значения берутся только из событий бэкенда (stepsDone / stepsTotal);
 * промежуточных «случайных» приращений нет.
 */
export function ExecutionProgress({ operation, plan }: { operation: Operation; plan?: ActionPlan | null }) {
  const steps = plan ? plan.steps.filter((s) => s.enabled) : Array.from({ length: operation.stepsTotal }, (_, i) => ({ id: `s${i}`, title: `Шаг ${i + 1}`, tool: "" }));
  const running = operation.status === "running";
  const failed = operation.status === "failed" || operation.status === "blocked";
  const cancelled = operation.status === "cancelled" || operation.status === "expired";

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-3 text-sm">
        <span className="text-text-secondary">Выполнено шагов</span>
        <span className="tabular font-medium">{operation.stepsDone} из {operation.stepsTotal}</span>
      </div>
      <ProgressBar done={operation.stepsDone} total={operation.stepsTotal} label="Прогресс выполнения" tone={failed ? "danger" : operation.status === "succeeded" ? "success" : "primary"} />
      <ol className="mt-4 space-y-2">
        {steps.map((s, i) => {
          const done = i < operation.stepsDone;
          const current = running && i === operation.stepsDone;
          const bad = failed && i === operation.stepsDone;
          const skipped = cancelled && !done;
          const Icon = done ? CheckCircle2 : current ? Loader2 : bad ? XCircle : skipped ? CircleSlash : Circle;
          return (
            <li key={s.id} className="flex items-start gap-3 text-sm">
              <Icon aria-hidden className={cn("mt-0.5 size-4 shrink-0", done && "text-success", current && "sm-spin text-info", bad && "text-danger", !done && !current && !bad && "text-text-muted")} />
              <span className={cn("min-w-0", done ? "text-text" : "text-text-secondary")}>
                {s.title}
                {"tool" in s && s.tool && <span className="ml-2 font-mono text-xs text-text-muted">{s.tool}</span>}
                <span className="sr-only">{done ? " — выполнено" : current ? " — выполняется" : bad ? " — ошибка" : skipped ? " — не выполнено" : " — ожидает"}</span>
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
