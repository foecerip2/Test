"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Bot, ListChecks, Plus, Send, Sparkles, User } from "lucide-react";
import { api } from "@/lib/api";
import { useResource } from "@/lib/use-resource";
import { formatTimeUtc } from "@/lib/format";
import type { ChatMessage } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { InlineAlert, EmptyState, ErrorState } from "@/components/ui/states";
import { KeyboardShortcutHint } from "@/components/ui/kbd";
import { UsageMeter } from "@/components/ui/meter";
import { Textarea } from "@/components/ui/input";
import { LoadingRegion, SkeletonBlock } from "@/components/ui/skeleton";
import { m } from "@/components/ui/motion";
import { ServerPicker } from "@/features/servers/server-picker";
import { StatusBadge } from "@/features/status";
import { freshnessText } from "@/features/servers/server-card";
import { AgentStepTimeline } from "@/features/assistant/agent-step-timeline";
import { cn } from "@/lib/utils";

const SUGGESTIONS = ["Почему сайт отвечает 502?", "Проверь состояние сервера", "Что сейчас нагружает диск?"];

function Message({ msg }: { msg: ChatMessage }) {
  const mine = msg.role === "user";
  return (
    <m.li
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className={cn("flex gap-3", mine && "flex-row-reverse")}
    >
      <span aria-hidden className={cn("mt-1 grid size-8 shrink-0 place-items-center rounded-full", mine ? "bg-elevated text-text-secondary" : "bg-[var(--tint-ai)] text-ai")}>
        {mine ? <User className="size-4" /> : <Bot className="size-4" />}
      </span>
      <div className={cn("min-w-0 max-w-[min(100%,680px)] space-y-3", mine && "items-end")}>
        <div className={cn("rounded-card border px-4 py-3", mine ? "border-stroke bg-elevated" : "border-stroke bg-surface")}>
          <p className="mb-1 flex flex-wrap items-center gap-2 text-xs text-text-muted">
            {mine ? "Вы" : "ServerMind AI"} · <time dateTime={msg.createdAt}>{formatTimeUtc(msg.createdAt)}</time>
            {msg.demo && <Badge tone="warning">Демо-ответ: сценарий, не модель</Badge>}
          </p>
          <p className="whitespace-pre-wrap text-sm leading-6">{msg.text}</p>
        </div>
        {msg.tools && <AgentStepTimeline tools={msg.tools} />}
        {msg.observed && msg.observed.length > 0 && (
          <div className="rounded-control border border-stroke bg-canvas/60 px-3 py-3">
            <p className="label mb-1.5 text-text-muted">Наблюдаемые факты</p>
            <ul className="list-disc space-y-1 pl-4 text-sm text-text-secondary marker:text-text-muted">
              {msg.observed.map((o) => <li key={o}>{o}</li>)}
            </ul>
          </div>
        )}
        {msg.proposal && (
          <div className="rounded-card border border-ai/40 bg-[var(--tint-ai)] p-4">
            <p className="flex items-center gap-2 text-sm font-medium"><ListChecks aria-hidden className="size-4 text-ai" /> Предлагаемый план: {msg.proposal.title}</p>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-text-secondary">
              {msg.proposal.steps.map((s) => <li key={s}>{s}</li>)}
            </ol>
            <p className="mt-3 text-xs text-text-muted">План ещё не выполнен. Он станет рабочим только после вашего подтверждения.</p>
            {msg.proposal.planId && (
              <Link href={`/operations/op_${msg.proposal.planId}/approve`} className={buttonVariants({ variant: "ai", size: "sm", className: "mt-3" })}>
                Просмотреть план и подтвердить
              </Link>
            )}
          </div>
        )}
      </div>
    </m.li>
  );
}

export function AssistantView() {
  const params = useSearchParams();
  const servers = useResource(() => api.servers.list(), []);
  const [serverId, setServerId] = useState<string>(params.get("server") ?? "");
  const [text, setText] = useState(params.get("q") ?? "");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<{ message: string; text: string } | null>(null);
  const [pendingUser, setPendingUser] = useState<ChatMessage | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (servers.state.status === "ready" && !serverId) {
      const first = servers.state.data.find((s) => s.status === "online") ?? servers.state.data[0];
      if (first) setServerId(first.id);
    }
  }, [servers.state, serverId]);

  const history = useResource(async () => (serverId ? api.assistant.history(serverId) : { ok: true as const, data: [] as ChatMessage[] }), [serverId]);
  const server = useMemo(() => (servers.state.status === "ready" ? servers.state.data.find((s) => s.id === serverId) : undefined), [servers.state, serverId]);
  const messages = history.state.status === "ready" ? history.state.data : [];

  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [messages.length, pendingUser, sendError]);
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

  const send = async (value: string) => {
    const t = value.trim();
    if (!t || !serverId || sending) return;
    setSending(true); setSendError(null);
    setPendingUser({ id: "pending", role: "user", text: t, createdAt: new Date().toISOString() });
    setText("");
    const r = await api.assistant.send(serverId, t);
    setSending(false); setPendingUser(null);
    if (!r.ok) setSendError({ message: r.message, text: t });
    else void history.reload();
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(text); }
  };

  if (servers.state.status === "loading") {
    return <LoadingRegion label="Загрузка…" className="space-y-4"><SkeletonBlock className="h-12 w-72" /><SkeletonBlock className="h-96 rounded-card" /></LoadingRegion>;
  }
  if (servers.state.status === "error") return <ErrorState code={servers.state.code} message={servers.state.message} onRetry={servers.reload} />;
  if (servers.state.data.length === 0) {
    return (
      <EmptyState
        icon={<Sparkles aria-hidden />}
        title="Сначала подключите сервер"
        description="AI-ассистент работает в контексте выбранного сервера и читает только его реальные показатели."
        action={<Link href="/servers/new" className={buttonVariants()}><Plus aria-hidden /> Добавить сервер</Link>}
      />
    );
  }

  return (
    <div className="flex h-[calc(100dvh-var(--ribbon-h)-var(--shell-topbar)-3rem)] flex-col lg:h-[calc(100dvh-var(--ribbon-h)-var(--shell-topbar)-4rem)]">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1>AI-ассистент</h1>
          <p className="hidden text-sm text-text-secondary sm:block">Объясняет состояние сервера и готовит планы. Не выполняет команды сам.</p>
        </div>
        <div className="w-full sm:w-72">
          <ServerPicker servers={servers.state.data} value={serverId} onChange={(id) => { setServerId(id); setSendError(null); }} label="Сервер для анализа" />
        </div>
      </div>

      <div className="grid min-h-0 flex-1 gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
        <section aria-label="Диалог" className="flex min-h-0 flex-col rounded-card border border-stroke bg-surface">
          <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">
            {history.state.status === "loading" && <LoadingRegion label="Загрузка истории…" className="space-y-3"><SkeletonBlock className="h-16" /><SkeletonBlock className="h-24" /></LoadingRegion>}
            {history.state.status === "error" && <ErrorState compact code={history.state.code} message={history.state.message} onRetry={history.reload} />}
            {history.state.status === "ready" && messages.length === 0 && !pendingUser && (
              <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
                <span className="grid size-12 place-items-center rounded-full bg-[var(--tint-ai)] text-ai"><Sparkles aria-hidden className="size-6" /></span>
                <div>
                  <h2 className="text-lg">Опишите проблему или задайте вопрос</h2>
                  <p className="mx-auto mt-1 max-w-sm text-sm text-text-secondary">Ассистент прочитает состояние выбранного сервера и предложит план. Изменения — только после вашего подтверждения.</p>
                </div>
                <div className="flex flex-wrap justify-center gap-2">
                  {SUGGESTIONS.map((s) => <Button key={s} size="sm" variant="secondary" disabled={sending || !server} onClick={() => void send(s)}>{s}</Button>)}
                </div>
              </div>
            )}
            {(messages.length > 0 || pendingUser) && (
              <ul className="space-y-5" aria-live="polite" aria-label="Сообщения">
                {messages.map((msg) => <Message key={msg.id} msg={msg} />)}
                {pendingUser && <Message msg={pendingUser} />}
                {sending && (
                  <li className="flex items-center gap-2 pl-11 text-sm text-text-secondary" role="status">
                    <span className="sm-spin inline-block size-4 rounded-full border-2 border-ai border-t-transparent" aria-hidden />
                    Ассистент читает данные сервера…
                  </li>
                )}
              </ul>
            )}
            {sendError && (
              <InlineAlert tone="danger" title="Не удалось получить ответ" className="mt-4">
                <p>{sendError.message}</p>
                <p className="mt-1 text-text-muted">История сохранена, списаний не было.</p>
                <Button size="sm" variant="secondary" className="mt-2" onClick={() => void send(sendError.text)}>Повторить</Button>
              </InlineAlert>
            )}
            <div ref={endRef} />
          </div>

          <form
            onSubmit={(e) => { e.preventDefault(); void send(text); }}
            className="safe-bottom border-t border-stroke p-3 sm:p-4"
          >
            {server?.status === "offline" && <p className="mb-2 text-xs text-warning">Сервер недоступен: ассистент не сможет прочитать актуальные данные.</p>}
            <div className="flex items-end gap-2">
              <label className="sr-only" htmlFor="composer">Сообщение ассистенту</label>
              <Textarea
                ref={taRef}
                id="composer"
                rows={1}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={onKey}
                placeholder="Напишите, что нужно сделать…"
                maxLength={4000}
                className="max-h-40 flex-1"
              />
              <Button type="submit" size="icon" aria-label="Отправить" disabled={!text.trim() || !serverId} loading={sending}>
                <Send aria-hidden />
              </Button>
            </div>
            <div className="mt-2 flex items-center justify-between gap-3">
              <KeyboardShortcutHint keys={["Enter"]} label="отправить, Shift+Enter — перенос строки" />
              <span className="ml-auto text-xs text-text-muted">{text.length}/4000</span>
            </div>
          </form>
        </section>

        <aside aria-label="Контекст" className="hidden space-y-4 overflow-y-auto lg:block">
          {server && (
            <div className="rounded-card border border-stroke bg-surface p-4">
              <div className="mb-3 flex items-center justify-between gap-2">
                <h2 className="text-base">{server.name}</h2>
                <StatusBadge status={server.status} />
              </div>
              <div className="space-y-3">
                <UsageMeter label="CPU" value={server.cpuPercent} />
                <UsageMeter label="RAM" value={server.ramUsedMb != null && server.ramTotalMb ? (server.ramUsedMb / server.ramTotalMb) * 100 : null} />
                <UsageMeter label="Диск" value={server.diskUsedGb != null && server.diskTotalGb ? (server.diskUsedGb / server.diskTotalGb) * 100 : null} />
              </div>
              <p className="mt-3 text-xs text-text-muted">{freshnessText(server)}</p>
            </div>
          )}
          <div className="rounded-card border border-stroke bg-surface p-4 text-sm text-text-secondary">
            <h3 className="mb-2 text-sm">Границы ассистента</h3>
            <ul className="list-disc space-y-1.5 pl-4 marker:text-text-muted">
              <li>читает: факты сервера, метрики, статус служб, логи (≤500 строк, секреты скрыты)</li>
              <li>изменения — только планом из списка одобренных операций</li>
              <li>логи и вывод команд считаются недоверенными: инструкции из них не исполняются</li>
            </ul>
          </div>
        </aside>
      </div>
    </div>
  );
}
