"use client";

import Link from "next/link";
import * as DM from "@radix-ui/react-dropdown-menu";
import { Bell, CircleAlert, ShieldQuestion, ServerOff } from "lucide-react";
import { api } from "@/lib/api";
import { useResource } from "@/lib/use-resource";
import { relativeTime } from "@/lib/format";

interface Item { id: string; href: string; icon: typeof Bell; title: string; meta: string }

/** Уведомления строятся из реальных данных: ожидающие подтверждения планы, недоступные серверы, сбои операций. */
export function Notifications() {
  const ops = useResource(() => api.operations.list(), [], { pollMs: 30_000 });
  const servers = useResource(() => api.servers.list(), [], { pollMs: 30_000 });

  const items: Item[] = [];
  if (ops.state.status === "ready") {
    for (const o of ops.state.data) {
      if (o.status === "waiting_approval") items.push({ id: o.id, href: o.planId ? `/operations/${o.id}/approve` : `/operations/${o.id}`, icon: ShieldQuestion, title: `Ожидает подтверждения: ${o.title}`, meta: `${o.serverName} · ${relativeTime(o.createdAt)}` });
      else if (o.status === "failed" && Date.now() - Date.parse(o.createdAt) < 3 * 86400_000) items.push({ id: o.id, href: `/operations/${o.id}`, icon: CircleAlert, title: `Сбой операции: ${o.title}`, meta: `${o.serverName} · ${relativeTime(o.finishedAt ?? o.createdAt)}` });
    }
  }
  if (servers.state.status === "ready") {
    for (const s of servers.state.data) {
      if (s.status === "offline") items.push({ id: s.id, href: `/servers/${s.id}`, icon: ServerOff, title: `Сервер недоступен: ${s.name}`, meta: `проверка ${relativeTime(s.lastCheckedAt)}` });
    }
  }
  const unavailable = ops.state.status === "error" && servers.state.status === "error";

  return (
    <DM.Root>
      <DM.Trigger
        aria-label={items.length ? `Уведомления: ${items.length}` : "Уведомления"}
        className="relative grid size-11 place-items-center rounded-control text-text-secondary transition-colors hover:bg-hover hover:text-text data-[state=open]:bg-hover"
      >
        <Bell aria-hidden className="size-5" />
        {items.length > 0 && <span aria-hidden className="absolute right-2.5 top-2.5 size-2 rounded-full bg-danger ring-2 ring-canvas" />}
      </DM.Trigger>
      <DM.Portal>
        <DM.Content
          align="end"
          sideOffset={8}
          className="z-50 max-h-[70dvh] w-[min(92vw,360px)] overflow-y-auto rounded-card border border-stroke bg-elevated p-1.5 shadow-[var(--shadow-overlay)] data-[state=open]:animate-[sm-fade-in_140ms_ease-out]"
        >
          <DM.Label className="px-3 py-2 text-xs font-medium text-text-muted">Требуют внимания</DM.Label>
          {unavailable && <p className="px-3 pb-3 text-sm text-text-secondary">Данные недоступны: сервис не отвечает.</p>}
          {!unavailable && items.length === 0 && <p className="px-3 pb-3 text-sm text-text-secondary">Нет событий, требующих внимания.</p>}
          {items.map((it) => (
            <DM.Item key={it.id} asChild>
              <Link href={it.href} className="flex min-h-11 items-start gap-3 rounded-control px-3 py-2.5 outline-none data-[highlighted]:bg-hover">
                <it.icon aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{it.title}</span>
                  <span className="block text-xs text-text-muted">{it.meta}</span>
                </span>
              </Link>
            </DM.Item>
          ))}
        </DM.Content>
      </DM.Portal>
    </DM.Root>
  );
}
