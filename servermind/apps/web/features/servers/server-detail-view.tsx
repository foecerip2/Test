"use client";

import Link from "next/link";
import { useState } from "react";
import { Activity, Clipboard, FileText, RefreshCw, Rocket, Sparkles } from "lucide-react";
import { api } from "@/lib/api";
import { useResource } from "@/lib/use-resource";
import { formatDateTimeUtc, formatUptime, gb, maskHost, mbToGb } from "@/lib/format";
import { useToast } from "@/lib/toast";
import { PageHeader } from "@/components/layout/page-header";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { UsageMeter } from "@/components/ui/meter";
import { MetricChart } from "@/components/ui/charts";
import { ErrorState, InlineAlert } from "@/components/ui/states";
import { LoadingRegion, SkeletonBlock } from "@/components/ui/skeleton";
import { JobStatusBadge, ServiceStateBadge, SourceBadge, StatusBadge } from "@/features/status";
import { freshnessText } from "@/features/servers/server-card";

const pct = (u: number | null, t: number | null) => (u == null || !t ? null : (u / t) * 100);

export function ServerDetailView({ id }: { id: string }) {
  const server = useResource(() => api.servers.get(id), [id], { pollMs: 60_000 });
  const history = useResource(() => api.monitoring.history(id, 24), [id]);
  const ops = useResource(() => api.operations.list(), []);
  const toast = useToast();
  const [checking, setChecking] = useState(false);
  const [logUnit, setLogUnit] = useState<string | null>(null);
  const logs = useResource(
    async () => (logUnit ? api.servers.logs(id, logUnit) : { ok: true as const, data: { lines: [], fetchedAt: "", source: "demo" as const } }),
    [id, logUnit],
  );

  if (server.state.status === "loading") {
    return (
      <LoadingRegion label="Загрузка сервера…">
        <SkeletonBlock className="mb-6 h-16 w-2/3" />
        <div className="grid gap-5 lg:grid-cols-3"><SkeletonBlock className="h-64 rounded-card" /><SkeletonBlock className="h-64 rounded-card lg:col-span-2" /></div>
      </LoadingRegion>
    );
  }
  if (server.state.status === "error") {
    return <ErrorState code={server.state.code} message={server.state.message} onRetry={server.reload} />;
  }
  const s = server.state.data;

  const recheck = async () => {
    setChecking(true);
    const r = await api.servers.recheck(id);
    setChecking(false);
    toast.push(r.ok ? { tone: "success", title: "Проверка выполнена", description: "Данные обновлены." } : { tone: "error", title: "Проверка не удалась", description: r.message });
    void server.reload();
  };

  const copyReport = async () => {
    const report = [
      "ServerMind — диагностический отчёт",
      `Сервер: ${s.name}`, `Адрес: ${maskHost(s.host)} (скрыт)`, `Статус: ${s.status}`, `ОС: ${s.os ?? "—"}`,
      `CPU: ${s.cpuPercent ?? "—"}%`, `Проверено: ${formatDateTimeUtc(s.lastCheckedAt)}`,
      `Службы: ${s.services.map((x) => `${x.name}=${x.state}`).join(", ") || "—"}`,
      s.source === "demo" ? "Источник: ДЕМО-ДАННЫЕ" : "Источник: SSH",
    ].join("\n");
    try { await navigator.clipboard.writeText(report); toast.push({ tone: "success", title: "Отчёт скопирован", description: "IP-адрес и ключи скрыты." }); }
    catch { toast.push({ tone: "error", title: "Не удалось скопировать", description: "Разрешите доступ к буферу обмена." }); }
  };

  const related = ops.state.status === "ready" ? ops.state.data.filter((o) => o.serverId === id).slice(0, 5) : [];

  return (
    <>
      <PageHeader
        back={{ href: "/servers", label: "Серверы" }}
        title={<span className="flex flex-wrap items-center gap-3">{s.name} <StatusBadge status={s.status} /> <SourceBadge source={s.source} /></span>}
        description={<span className="font-mono text-xs">{s.username}@{s.host}:{s.port}</span>}
        actions={
          <>
            <Button variant="secondary" onClick={recheck} loading={checking}><RefreshCw aria-hidden /> Проверить сейчас</Button>
            <Link href={`/assistant?server=${s.id}`} className={buttonVariants({ variant: "ai" })}><Sparkles aria-hidden /> Анализ</Link>
            <Link href="/deploy" className={buttonVariants({ variant: "secondary" })}><Rocket aria-hidden /> Деплой</Link>
          </>
        }
      />

      {s.status === "offline" && (
        <InlineAlert tone="warning" title="Сервер недоступен" className="mb-5">
          {freshnessText(s)}. Показатели ниже — последние известные, а не текущие. Проверьте сеть, порт SSH и firewall у провайдера.
        </InlineAlert>
      )}

      <div className="grid gap-5 lg:grid-cols-3">
        <Card>
          <CardHeader><CardTitle>Состояние</CardTitle></CardHeader>
          <CardContent className="space-y-5">
            <UsageMeter label="CPU" value={s.cpuPercent} />
            <UsageMeter label="RAM" value={pct(s.ramUsedMb, s.ramTotalMb)} detail={s.ramUsedMb != null ? `${mbToGb(s.ramUsedMb)} из ${mbToGb(s.ramTotalMb)}` : undefined} />
            <UsageMeter label="Диск" value={pct(s.diskUsedGb, s.diskTotalGb)} detail={s.diskUsedGb != null ? `${gb(s.diskUsedGb)} из ${gb(s.diskTotalGb)}` : undefined} />
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 border-t border-stroke pt-4 text-sm">
              <dt className="text-text-muted">ОС</dt><dd className="text-right">{s.os ?? "—"}</dd>
              <dt className="text-text-muted">Uptime</dt><dd className="tabular text-right">{formatUptime(s.uptimeSeconds)}</dd>
              <dt className="text-text-muted">Проверено</dt><dd className="tabular text-right">{formatDateTimeUtc(s.lastCheckedAt)}</dd>
              <dt className="text-text-muted">Источник</dt><dd className="text-right">{s.source === "demo" ? "демо-данные" : "SSH-опрос"}</dd>
            </dl>
            <div>
              <p className="label mb-1 text-text-muted">Отпечаток ключа сервера</p>
              <p className="break-all font-mono text-xs text-text-secondary">{s.fingerprint}</p>
            </div>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Нагрузка за 24 часа</CardTitle>
            <Link href="/monitoring" className="inline-flex min-h-10 items-center gap-1 text-sm text-primary hover:underline"><Activity aria-hidden className="size-4" /> Мониторинг</Link>
          </CardHeader>
          <CardContent>
            {history.state.status === "loading" && <SkeletonBlock className="h-52" />}
            {history.state.status === "error" && <ErrorState compact code={history.state.code} message={history.state.message} onRetry={history.reload} />}
            {history.state.status === "ready" && (
              history.state.data.samples.length < 2
                ? <p className="py-10 text-center text-sm text-text-muted">Недостаточно данных: история измерений ещё не накоплена.</p>
                : <MetricChart samples={history.state.data.samples} />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Службы</CardTitle></CardHeader>
          <CardContent>
            {s.services.length === 0 ? (
              <p className="text-sm text-text-muted">Нет данных о службах — сервер недоступен или проверка не выполнялась.</p>
            ) : (
              <ul className="divide-y divide-stroke">
                {s.services.map((svc) => (
                  <li key={svc.name} className="flex min-h-11 items-center justify-between gap-3 py-1.5">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate font-mono text-sm">{svc.name}</span>
                      {svc.managed && <Badge tone="primary">managed</Badge>}
                    </span>
                    <span className="flex items-center gap-2">
                      <ServiceStateBadge state={svc.state} />
                      <Button size="iconSm" variant="ghost" aria-label={`Показать логи ${svc.name}`} onClick={() => setLogUnit(svc.name)}><FileText aria-hidden /></Button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader><CardTitle>Последние операции</CardTitle><Link href="/operations" className="inline-flex min-h-10 items-center text-sm text-primary hover:underline">Все операции</Link></CardHeader>
          <CardContent>
            {ops.state.status === "loading" && <SkeletonBlock className="h-24" />}
            {ops.state.status === "error" && <p className="text-sm text-text-muted">Операции недоступны: {ops.state.message}</p>}
            {ops.state.status === "ready" && related.length === 0 && <p className="text-sm text-text-muted">По этому серверу операций ещё не было.</p>}
            <ul className="divide-y divide-stroke">
              {related.map((o) => (
                <li key={o.id}>
                  <Link href={`/operations/${o.id}`} className="flex min-h-14 flex-wrap items-center justify-between gap-2 py-2 hover:text-primary">
                    <span className="min-w-0 truncate font-medium">{o.title}</span>
                    <JobStatusBadge status={o.status} />
                  </Link>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>

      {logUnit && (
        <Card className="mt-5">
          <CardHeader>
            <CardTitle>Логи: <span className="font-mono">{logUnit}</span></CardTitle>
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={copyReport}><Clipboard aria-hidden /> Скопировать отчёт</Button>
              <Button size="sm" variant="secondary" onClick={() => setLogUnit(null)}>Закрыть</Button>
            </div>
          </CardHeader>
          <CardContent>
            <p className="mb-3 text-xs text-text-muted">Только чтение. Не более 500 строк и 64 КиБ за запрос; секреты скрываются до показа и до отправки в AI.</p>
            {logs.state.status === "loading" && <SkeletonBlock className="h-32" />}
            {logs.state.status === "error" && <ErrorState compact code={logs.state.code} message={logs.state.message} onRetry={logs.reload} />}
            {logs.state.status === "ready" && (
              <pre tabIndex={0} aria-label={`Логи ${logUnit}`} className="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-control border border-stroke bg-canvas p-3 font-mono text-xs leading-5 text-text-secondary">
                {logs.state.data.lines.join("\n") || "Записей нет."}
              </pre>
            )}
          </CardContent>
        </Card>
      )}
    </>
  );
}
