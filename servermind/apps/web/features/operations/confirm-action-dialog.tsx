"use client";

import { useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { planRisk, shortHash } from "@/lib/plan";
import type { ActionPlan } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { CheckboxField } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { InlineAlert } from "@/components/ui/states";
import { RiskBadge } from "@/features/status";

/**
 * Явное подтверждение. Кнопка недоступна, пока пользователь не отметит проверку плана;
 * подтверждение привязано к ревизии и хешу — при смене плана диалог сбрасывается.
 */
export function ConfirmActionDialog({
  open, onOpenChange, plan, onConfirm, error,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  plan: ActionPlan;
  onConfirm: () => Promise<void>;
  error?: string | null;
}) {
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setChecked(false); }, [plan.revision, plan.canonicalHash, open]);
  const n = plan.steps.filter((s) => s.enabled).length;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!busy) onOpenChange(o); }}>
      <DialogContent title="Подтвердить выполнение?" description={`Сервер ${plan.serverName} · ${n} шаг(ов) · ревизия ${plan.revision}`}>
        <div className="space-y-4 p-5">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <RiskBadge risk={planRisk(plan)} />
            <code className="rounded-control border border-stroke bg-canvas px-2 py-1 font-mono text-xs">{shortHash(plan.canonicalHash)}</code>
          </div>
          <p className="text-sm text-text-secondary">
            Будет выполнено ровно то, что показано в плане: «{plan.title}». Подтверждение действует только для этой ревизии и этого хеша — после любого изменения плана его нужно дать заново.
          </p>
          {error && <InlineAlert tone="danger" title="Не удалось подтвердить">{error}</InlineAlert>}
          <CheckboxField checked={checked} onCheckedChange={(v) => setChecked(v === true)} label="Я проверил шаги, параметры и хеш плана и разрешаю выполнение на сервере" />
        </div>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>Отмена</Button>
          <Button
            disabled={!checked}
            loading={busy}
            onClick={async () => { setBusy(true); try { await onConfirm(); } finally { setBusy(false); } }}
          >
            <ShieldCheck aria-hidden /> Подтвердить и выполнить
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
