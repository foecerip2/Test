"use client";

import { useMemo, useState } from "react";
import { ListChecks } from "lucide-react";
import { api } from "@/lib/api";
import { useResource } from "@/lib/use-resource";
import type { JobStatus } from "@/lib/types";
import { PageHeader } from "@/components/layout/page-header";
import { Select } from "@/components/ui/input";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { LoadingRegion, SkeletonBlock } from "@/components/ui/skeleton";
import { OperationList } from "@/features/operations/operation-row";

const STATUS_OPTIONS: { value: "all" | JobStatus; label: string }[] = [
  { value: "all", label: "Все статусы" },
  { value: "waiting_approval", label: "Ждут подтверждения" },
  { value: "running", label: "Выполняются" },
  { value: "succeeded", label: "Выполнены" },
  { value: "failed", label: "С ошибкой" },
  { value: "cancelled", label: "Отменены" },
  { value: "expired", label: "Истекли" },
  { value: "blocked", label: "Остановлены проверкой" },
];

export function OperationsView() {
  const { state, reload } = useResource(() => api.operations.list(), [], { pollMs: 5000 });
  const [status, setStatus] = useState<"all" | JobStatus>("all");

  const items = useMemo(() => {
    if (state.status !== "ready") return [];
    return state.data
      .filter((o) => status === "all" || o.status === status)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }, [state, status]);

  return (
    <>
      <PageHeader title="Операции" description="Журнал заданий: план, подтверждение, исполнение. Изменения на серверах выполняются только после подтверждения." />
      {state.status === "loading" && (
        <LoadingRegion label="Загрузка операций…" className="space-y-3">
          {[0, 1, 2, 3].map((i) => <SkeletonBlock key={i} className="h-14 rounded-card" />)}
        </LoadingRegion>
      )}
      {state.status === "error" && <ErrorState code={state.code} message={state.message} onRetry={reload} />}
      {state.status === "ready" && (
        state.data.length === 0 ? (
          <EmptyState icon={<ListChecks aria-hidden />} title="Операций пока нет" description="Они появятся, когда AI-ассистент подготовит план или вы запустите деплой." />
        ) : (
          <>
            <div className="mb-4 max-w-xs">
              <Select aria-label="Фильтр по статусу" value={status} onChange={(e) => setStatus(e.target.value as "all" | JobStatus)}>
                {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </Select>
            </div>
            {items.length === 0 ? <EmptyState title="Нет операций с таким статусом" /> : <OperationList items={items} />}
          </>
        )
      )}
    </>
  );
}
