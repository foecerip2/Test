"use client";

import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { api } from "@/lib/api";
import { useResource } from "@/lib/use-resource";
import { formatTimeUtc, gb, mbToGb, relativeTime } from "@/lib/format";
import type { ServerSummary } from "@/lib/types";
import { UsageMeter } from "@/components/ui/meter";
import { MetricSparkline } from "@/components/ui/charts";
import { SourceBadge, StatusBadge } from "@/features/status";

export function freshnessText(s: ServerSummary): string {
  if (s.status === "offline") return `Сервер недоступен — последняя успешная проверка: ${formatTimeUtc(s.lastSuccessAt)}`;
  if (!s.lastCheckedAt) return "Проверок ещё не было";
  return `Проверено ${formatTimeUtc(s.lastCheckedAt)} · ${relativeTime(s.lastCheckedAt)}`;
}

const pct = (used: number | null, total: number | null) => (used == null || !total ? null : (used / total) * 100);

function CpuSpark({ id }: { id: string }) {
  const { state } = useResource(() => api.monitoring.history(id, 6), [id]);
  if (state.status !== "ready" || state.data.samples.length < 2) return null;
  return <MetricSparkline values={state.data.samples.map((x) => x.cpu)} label="CPU за 6 часов" className="h-7 w-full" />;
}

export function ServerCard({ server, spark }: { server: ServerSummary; spark?: boolean }) {
  const offline = server.status === "offline";
  return (
    <Link
      href={`/servers/${server.id}`}
      className="group block min-w-0 rounded-card border border-stroke bg-surface p-5 shadow-[var(--shadow-card)] transition-colors duration-120 hover:border-text-muted/50 hover:bg-elevated"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-base font-semibold">{server.name}</h3>
            <SourceBadge source={server.source} />
          </div>
          <p className="mt-0.5 truncate font-mono text-xs text-text-muted">{server.username}@{server.host}:{server.port}</p>
          <p className="truncate text-xs text-text-muted">{server.os ?? "ОС не определена"}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <StatusBadge status={server.status} />
          <ChevronRight aria-hidden className="size-4 text-text-muted transition-transform group-hover:translate-x-0.5" />
        </div>
      </div>

      <div className={`mt-4 grid grid-cols-1 gap-4 min-[480px]:grid-cols-3`}>
        <UsageMeter label="CPU" value={server.cpuPercent} />
        <UsageMeter label="RAM" value={pct(server.ramUsedMb, server.ramTotalMb)} detail={server.ramUsedMb != null ? `${mbToGb(server.ramUsedMb)} / ${mbToGb(server.ramTotalMb)}` : undefined} />
        <UsageMeter label="Диск" value={pct(server.diskUsedGb, server.diskTotalGb)} detail={server.diskUsedGb != null ? `${gb(server.diskUsedGb)} / ${gb(server.diskTotalGb)}` : undefined} />
      </div>
      {spark && !offline && <div className="mt-3"><CpuSpark id={server.id} /></div>}

      <p className={`mt-4 border-t border-stroke pt-3 text-xs ${offline ? "text-warning" : "text-text-muted"}`}>
        {freshnessText(server)}
      </p>
    </Link>
  );
}
