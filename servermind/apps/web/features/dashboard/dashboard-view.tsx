"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { Boxes, CircleCheck, Plus, Send, Server, ShieldQuestion, Sparkles, Zap } from "lucide-react";
import { api } from "@/lib/api";
import { useResource, type ResourceState } from "@/lib/use-resource";
import { formatNumber, plural } from "@/lib/format";
import { PageHeader } from "@/components/layout/page-header";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MetricChart } from "@/components/ui/charts";
import { Textarea } from "@/components/ui/input";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { SkeletonBlock } from "@/components/ui/skeleton";
import { FadeIn } from "@/components/ui/motion";
import { ServerCard } from "@/features/servers/server-card";
import { ServerPicker } from "@/features/servers/server-picker";
import { OperationList } from "@/features/operations/operation-row";

function StatCard({ icon, label, value, sub, tone }: { icon: ReactNode; label: string; value: ReactNode; sub: string; tone?: "warning" }) {
  return (
    <Card className="p-5">
      <div className="flex items-center gap-3">
        <span className={`grid size-10 place-items-center rounded-control [&_svg]:size-5 ${tone === "warning" ? "bg-[var(--tint-warning)] text-warning" : "bg-primary-muted text-primary"}`} aria-hidden>{icon}</span>
        <div className="min-w-0">
          <p className="label text-text-secondary">{label}</p>
          <div className="kpi">{value}</div>
        </div>
      </div>
      <p className="mt-3 truncate text-xs text-text-muted">{sub}</p>
    </Card>
  );
}

const val = <T,>(s: ResourceState<T>, f: (d: T) => ReactNode): ReactNode =>
  s.status === "ready" ? f(s.data) : s.status === "loading" ? <SkeletonBlock className="mt-1 h-7 w-12" /> : "—";

function AssistantMini({ servers }: { servers: { id: string; name: string; status: "online" | "offline" | "checking" | "unknown" }[] }) {
  const router = useRouter();
  const [serverId, setServerId] = useState("");
  const [text, setText] = useState("");
  useEffect(() => { if (!serverId && servers[0]) setServerId((servers.find((s) => s.status === "online") ?? servers[0]).id); }, [servers, serverId]);
  const go = () => router.push(`/assistant?server=${serverId}${text.trim() ? `&q=${encodeURIComponent(text.trim())}` : ""}`);
  return (
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2"><Sparkles aria-hidden className="size-4 text-ai" /> AI-ассистент</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-text-secondary">Опишите проблему — ассистент прочитает состояние сервера и предложит план. Изменения — только с вашего подтверждения.</p>
        <ServerPicker servers={servers as never} value={serverId} onChange={setServerId} label="Сервер" />
        <Textarea aria-label="Вопрос ассистенту" rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="Например: почему сайт отвечает 502?" />
        <Button className="w-full" variant="ai" disabled={!serverId} onClick={go}><Send aria-hidden /> Открыть диалог</Button>
      </CardContent>
    </Card>
  );
}

function ResourceUsage({ servers }: { servers: { id: string; name: string; status: "online" | "offline" | "checking" | "unknown" }[] }) {
  const [id, setId] = useState("");
  useEffect(() => { if (!id && servers.length) setId((servers.find((s) => s.status === "online") ?? servers[0]!).id); }, [servers, id]);
  const history = useResource(async () => (id ? api.monitoring.history(id, 24) : { ok: true as const, data: { samples: [], intervalSec: 900, source: "ssh" as const } }), [id]);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Использование ресурсов · 24 ч</CardTitle>
        <div className="w-full sm:w-56"><ServerPicker servers={servers as never} value={id} onChange={setId} label="Сервер для графика" /></div>
      </CardHeader>
      <CardContent>
        {history.state.status === "loading" && <SkeletonBlock className="h-48" />}
        {history.state.status === "error" && <ErrorState compact code={history.state.code} message={history.state.message} onRetry={history.reload} />}
        {history.state.status === "ready" && (history.state.data.samples.length < 2
          ? <p className="py-10 text-center text-sm text-text-muted">Недостаточно данных: история измерений ещё не накоплена.</p>
          : <>
              <MetricChart samples={history.state.data.samples} />
              {history.state.data.source === "demo" && <p className="mt-3 text-xs text-warning">Демо-данные: график сгенерирован фикстурой, это не измерения сервера.</p>}
            </>)}
      </CardContent>
    </Card>
  );
}

export function DashboardView() {
  const servers = useResource(() => api.servers.list(), [], { pollMs: 60_000 });
  const ops = useResource(() => api.operations.list(), [], { pollMs: 10_000 });
  const bal = useResource(() => api.billing.balance(), []);

  const list = servers.state.status === "ready" ? servers.state.data : [];
  const online = list.filter((s) => s.status === "online").length;
  const offline = list.filter((s) => s.status === "offline");
  const waiting = ops.state.status === "ready" ? ops.state.data.filter((o) => o.status === "waiting_approval") : [];
  const recent = ops.state.status === "ready" ? [...ops.state.data].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, 5) : [];

  const description =
    servers.state.status === "loading" ? "Загрузка данных…"
    : servers.state.status === "error" ? "Данные недоступны — см. сообщение ниже."
    : list.length === 0 ? "Подключите первый сервер, чтобы увидеть реальное состояние."
    : offline.length > 0 ? `Недоступны: ${offline.map((s) => s.name).join(", ")}. Остальные серверы отвечают.`
    : `Все ${list.length} ${plural(list.length, "сервер отвечает", "сервера отвечают", "серверов отвечают")} на последней проверке.`;

  return (
    <>
      <PageHeader
        title="Обзор"
        description={description}
        actions={<Link href="/servers/new" className={buttonVariants()}><Plus aria-hidden /> Добавить сервер</Link>}
      />

      <div className="mb-6 grid grid-cols-2 gap-4 xl:grid-cols-4">
        <StatCard icon={<Server />} label="Серверы" value={val(servers.state, (d) => d.length)} sub={servers.state.status === "ready" ? "подключено" : "нет данных"} />
        <StatCard icon={<CircleCheck />} label="Онлайн" value={val(servers.state, () => online)} sub={servers.state.status === "ready" ? `из ${list.length}` : "нет данных"} />
        <StatCard icon={<Boxes />} label="На подтверждении" tone={waiting.length ? "warning" : undefined} value={val(ops.state, () => waiting.length)} sub={ops.state.status === "ready" ? `всего операций: ${ops.state.data.length}` : "нет данных"} />
        <StatCard icon={<Zap />} label="AI-кредиты" value={val(bal.state, (d) => formatNumber(d.available))} sub={bal.state.status === "ready" ? "по ledger" : "нет данных"} />
      </div>

      {servers.state.status === "error" && <ErrorState className="mb-6" code={servers.state.code} message={servers.state.message} onRetry={servers.reload} />}

      {waiting.length > 0 && (
        <FadeIn className="mb-6">
          <div role="region" aria-label="Ожидают подтверждения" className="rounded-card border border-warning/40 bg-[var(--tint-warning)] p-4">
            <p className="mb-2 flex items-center gap-2 font-medium"><ShieldQuestion aria-hidden className="size-5 text-warning" /> Ждут вашего подтверждения</p>
            <ul className="divide-y divide-warning/20">
              {waiting.map((o) => (
                <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="min-w-0"><span className="font-medium">{o.title}</span> <span className="text-sm text-text-secondary">· {o.serverName}</span></span>
                  <Link href={`/operations/${o.id}/approve`} className={buttonVariants({ size: "sm", variant: "secondary" })}>Проверить план</Link>
                </li>
              ))}
            </ul>
          </div>
        </FadeIn>
      )}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-w-0 space-y-6">
          <section aria-labelledby="srv-h">
            <div className="mb-3 flex items-center justify-between"><h2 id="srv-h">Серверы</h2><Link href="/servers" className="inline-flex min-h-10 items-center text-sm text-primary hover:underline">Все серверы</Link></div>
            {servers.state.status === "loading" && <div className="grid gap-5 md:grid-cols-2"><SkeletonBlock className="h-52 rounded-card" /><SkeletonBlock className="h-52 rounded-card" /></div>}
            {servers.state.status === "ready" && list.length === 0 && (
              <EmptyState icon={<Server aria-hidden />} title="Серверов пока нет" description="Подключите Ubuntu VPS по SSH-ключу." action={<Link href="/onboarding" className={buttonVariants()}>Начать подключение</Link>} />
            )}
            {list.length > 0 && <ul className="grid gap-5 md:grid-cols-2">{list.slice(0, 4).map((s) => <li key={s.id} className="min-w-0"><ServerCard server={s} spark /></li>)}</ul>}
          </section>
          {list.length > 0 && <ResourceUsage servers={list} />}
        </div>

        <div className="min-w-0 space-y-6">
          {list.length > 0 && <AssistantMini servers={list} />}
          <Card>
            <CardHeader><CardTitle>Последние операции</CardTitle><Link href="/operations" className="inline-flex min-h-10 items-center text-sm text-primary hover:underline">Все</Link></CardHeader>
            <CardContent className="pt-3">
              {ops.state.status === "loading" && <SkeletonBlock className="h-32" />}
              {ops.state.status === "error" && <ErrorState compact code={ops.state.code} message={ops.state.message} onRetry={ops.reload} />}
              {ops.state.status === "ready" && recent.length === 0 && <p className="text-sm text-text-muted">Операций ещё не было.</p>}
              {recent.length > 0 && <OperationList items={recent} compact />}
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
