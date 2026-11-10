"use client";

import { useEffect, useState } from "react";
import { Activity } from "lucide-react";
import { api } from "@/lib/api";
import { useResource } from "@/lib/use-resource";
import { formatDateTimeUtc } from "@/lib/format";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MetricChart } from "@/components/ui/charts";
import { Select } from "@/components/ui/input";
import { UsageMeter } from "@/components/ui/meter";
import { EmptyState, ErrorState, InlineAlert } from "@/components/ui/states";
import { SkeletonBlock } from "@/components/ui/skeleton";
import { ServerPicker } from "@/features/servers/server-picker";
import { StatusBadge } from "@/features/status";
import { freshnessText } from "@/features/servers/server-card";

const RANGES = [{ h: 6, label: "6 часов" }, { h: 24, label: "24 часа" }, { h: 168, label: "7 дней" }];

export function MonitoringView() {
  const servers = useResource(() => api.servers.list(), [], { pollMs: 60_000 });
  const [id, setId] = useState("");
  const [hours, setHours] = useState(24);
  const list = servers.state.status === "ready" ? servers.state.data : [];

  useEffect(() => { if (!id && list.length) setId((list.find((s) => s.status === "online") ?? list[0]!).id); }, [list, id]);
  const history = useResource(async () => (id ? api.monitoring.history(id, hours) : { ok: true as const, data: { samples: [], intervalSec: 900, source: "ssh" as const } }), [id, hours]);
  const server = list.find((s) => s.id === id);

  const data = history.state.status === "ready" ? history.state.data : null;
  const samples = data?.samples ?? [];
  const expected = data ? Math.floor((hours * 3600) / data.intervalSec) : 0;
  const coverage = data && expected ? Math.min(100, Math.round((samples.length / expected) * 100)) : null;
  const last = samples[samples.length - 1];

  const alerts: { id: string; tone: "warning" | "danger"; text: string }[] = [];
  if (server?.status === "offline") alerts.push({ id: "off", tone: "danger", text: freshnessText(server) });
  if (last && last.disk >= 90) alerts.push({ id: "disk90", tone: "danger", text: `Диск заполнен на ${last.disk.toFixed(0)}% — ресурсоёмкие операции блокируются.` });
  else if (last && last.disk >= 75) alerts.push({ id: "disk75", tone: "warning", text: `Диск заполнен на ${last.disk.toFixed(0)}% (порог предупреждения 75%).` });
  if (last && last.ram >= 90) alerts.push({ id: "ram", tone: "warning", text: `RAM занята на ${last.ram.toFixed(0)}%.` });

  return (
    <>
      <PageHeader title="Мониторинг" description="История измерений с отметками времени UTC. Данные собираются периодическим опросом по SSH, это не real-time." />

      {servers.state.status === "loading" && <SkeletonBlock className="h-72 rounded-card" />}
      {servers.state.status === "error" && <ErrorState code={servers.state.code} message={servers.state.message} onRetry={servers.reload} />}
      {servers.state.status === "ready" && list.length === 0 && <EmptyState icon={<Activity aria-hidden />} title="Нет серверов для мониторинга" description="Подключите сервер — история начнёт накапливаться после первых опросов." />}

      {list.length > 0 && (
        <div className="space-y-6">
          <div className="grid gap-3 sm:grid-cols-[minmax(0,320px)_180px]">
            <ServerPicker servers={list} value={id} onChange={setId} label="Сервер" />
            <Select aria-label="Период" value={hours} onChange={(e) => setHours(Number(e.target.value))}>
              {RANGES.map((r) => <option key={r.h} value={r.h}>{r.label}</option>)}
            </Select>
          </div>

          {alerts.length > 0 ? (
            <div className="space-y-2" role="region" aria-label="Предупреждения">
              {alerts.map((a) => <InlineAlert key={a.id} tone={a.tone}>{a.text}</InlineAlert>)}
            </div>
          ) : server && <p className="text-sm text-text-secondary">Активных предупреждений нет{last ? ` (по измерению ${formatDateTimeUtc(last.t)})` : ""}.</p>}

          <Card>
            <CardHeader>
              <CardTitle>Нагрузка · {RANGES.find((r) => r.h === hours)?.label}</CardTitle>
              <div className="flex flex-wrap items-center gap-2 text-xs text-text-secondary">
                {data && (data.intervalSec > 0
                  ? <Badge>опрос каждые {Math.round(data.intervalSec / 60)} мин</Badge>
                  : <Badge tone="warning">периодический опрос не настроен: точки появляются при ручной проверке</Badge>)}
                {coverage != null && <Badge tone={coverage < 50 ? "warning" : "neutral"}>покрытие данными: {coverage}%</Badge>}
                {data?.source === "demo" && <Badge tone="warning">Демо-данные</Badge>}
              </div>
            </CardHeader>
            <CardContent>
              {history.state.status === "loading" && <SkeletonBlock className="h-52" />}
              {history.state.status === "error" && <ErrorState compact code={history.state.code} message={history.state.message} onRetry={history.reload} />}
              {data && samples.length < 2 && (
                <EmptyState icon={<Activity aria-hidden />} title="Недостаточно данных" description="История измерений для этого сервера ещё не накоплена: график появится после нескольких успешных опросов. Подставных значений мы не рисуем." className="border-0 py-8" />
              )}
              {data && samples.length >= 2 && <MetricChart samples={samples} height={240} />}
            </CardContent>
          </Card>

          <section aria-labelledby="all-h">
            <h2 id="all-h" className="mb-3">Все серверы</h2>
            <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {list.map((s) => (
                <li key={s.id} className="rounded-card border border-stroke bg-surface p-4">
                  <div className="mb-3 flex items-center justify-between gap-2"><span className="truncate font-medium">{s.name}</span><StatusBadge status={s.status} /></div>
                  <div className="grid grid-cols-3 gap-3">
                    <UsageMeter label="CPU" value={s.cpuPercent} />
                    <UsageMeter label="RAM" value={s.ramUsedMb != null && s.ramTotalMb ? (s.ramUsedMb / s.ramTotalMb) * 100 : null} />
                    <UsageMeter label="Диск" value={s.diskUsedGb != null && s.diskTotalGb ? (s.diskUsedGb / s.diskTotalGb) * 100 : null} />
                  </div>
                  <p className="mt-3 text-xs text-text-muted">{freshnessText(s)}</p>
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}
    </>
  );
}
