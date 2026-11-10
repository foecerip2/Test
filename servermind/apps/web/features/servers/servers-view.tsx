"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Plus, Search, Server } from "lucide-react";
import { api } from "@/lib/api";
import { useResource } from "@/lib/use-resource";
import { plural } from "@/lib/format";
import type { ServerStatus } from "@/lib/types";
import { PageHeader } from "@/components/layout/page-header";
import { buttonVariants } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { LoadingRegion, SkeletonBlock } from "@/components/ui/skeleton";
import { ServerCard } from "@/features/servers/server-card";
import { FadeIn } from "@/components/ui/motion";

type Filter = "all" | ServerStatus;
type Sort = "name" | "status" | "checked";

export function ServersView() {
  const { state, reload } = useResource(() => api.servers.list(), [], { pollMs: 60_000 });
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>("name");

  const list = useMemo(() => {
    if (state.status !== "ready") return [];
    const needle = q.trim().toLowerCase();
    return state.data
      .filter((s) => (filter === "all" ? true : s.status === filter))
      .filter((s) => !needle || `${s.name} ${s.host} ${s.os ?? ""}`.toLowerCase().includes(needle))
      .sort((a, b) =>
        sort === "name" ? a.name.localeCompare(b.name, "ru")
        : sort === "status" ? a.status.localeCompare(b.status)
        : (Date.parse(b.lastCheckedAt ?? "0") || 0) - (Date.parse(a.lastCheckedAt ?? "0") || 0));
  }, [state, q, filter, sort]);

  const total = state.status === "ready" ? state.data.length : 0;

  return (
    <>
      <PageHeader
        title="Серверы"
        description={state.status === "ready" ? `${total} ${plural(total, "сервер", "сервера", "серверов")}` : "Подключённые VPS"}
        actions={<Link href="/servers/new" className={buttonVariants()}><Plus aria-hidden /> Добавить сервер</Link>}
      />

      {state.status === "loading" && (
        <LoadingRegion label="Загрузка серверов…" className="grid gap-5 md:grid-cols-2 2xl:grid-cols-3">
          {[0, 1, 2].map((i) => <SkeletonBlock key={i} className="h-56 rounded-card" />)}
        </LoadingRegion>
      )}
      {state.status === "error" && <ErrorState code={state.code} message={state.message} onRetry={reload} />}

      {state.status === "ready" && total === 0 && (
        <EmptyState
          icon={<Server aria-hidden />}
          title="Серверов пока нет"
          description="Подключите первый Ubuntu VPS по SSH-ключу — ServerMind покажет реальную нагрузку и поможет с диагностикой."
          action={<Link href="/servers/new" className={buttonVariants()}><Plus aria-hidden /> Добавить сервер</Link>}
        />
      )}

      {state.status === "ready" && total > 0 && (
        <FadeIn>
          <div className="mb-5 grid gap-3 sm:grid-cols-[1fr_180px_200px]">
            <div className="relative">
              <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-text-muted" />
              <Input aria-label="Поиск серверов" placeholder="Поиск по имени, адресу, ОС" value={q} onChange={(e) => setQ(e.target.value)} className="pl-9" />
            </div>
            <Select aria-label="Фильтр по статусу" value={filter} onChange={(e) => setFilter(e.target.value as Filter)}>
              <option value="all">Все статусы</option>
              <option value="online">Онлайн</option>
              <option value="offline">Недоступные</option>
              <option value="unknown">Нет данных</option>
            </Select>
            <Select aria-label="Сортировка" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
              <option value="name">По имени</option>
              <option value="status">По статусу</option>
              <option value="checked">По времени проверки</option>
            </Select>
          </div>
          {list.length === 0 ? (
            <EmptyState title="Ничего не найдено" description="Измените запрос или фильтр." />
          ) : (
            <ul className="grid gap-5 md:grid-cols-2 2xl:grid-cols-3" aria-label="Список серверов">
              {list.map((s) => <li key={s.id} className="min-w-0"><ServerCard server={s} spark /></li>)}
            </ul>
          )}
        </FadeIn>
      )}
    </>
  );
}
