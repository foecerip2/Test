"use client";

import { useState } from "react";
import { Users } from "lucide-react";
import { api } from "@/lib/api";
import { useResource } from "@/lib/use-resource";
import { useToast } from "@/lib/toast";
import { formatDateTimeUtc } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { SkeletonBlock } from "@/components/ui/skeleton";

/** Пользователи платформы: отключение закрывает все сессии сразу и блокирует вход. Только администратор платформы (сервер отвечает 404 остальным). */
export function UsersCard() {
  const toast = useToast();
  const list = useResource(() => api.admin.users(), []);
  const [busy, setBusy] = useState<string | null>(null);

  const toggle = async (id: string, active: boolean) => {
    setBusy(id);
    const r = await api.admin.setUserActive(id, active);
    setBusy(null);
    toast.push(r.ok ? { tone: "info", title: active ? "Пользователь включён" : "Пользователь отключён", description: active ? undefined : "Все его сессии закрыты." } : { tone: "error", title: "Не удалось изменить", description: r.message });
    void list.reload();
  };

  return (
    <Card className="xl:col-span-2">
      <CardHeader>
        <div>
          <CardTitle className="flex items-center gap-2"><Users aria-hidden className="size-4 text-primary" /> Пользователи</CardTitle>
          <CardDescription className="mt-1">Отключение немедленно закрывает все сессии пользователя и блокирует вход. Себя отключить нельзя.</CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        {list.state.status === "loading" && <SkeletonBlock className="h-16 rounded-card" />}
        {list.state.status === "error" && <ErrorState compact code={list.state.code} message={list.state.code === "not_found" ? "Раздел доступен администратору платформы (PLATFORM_ADMIN_EMAILS)." : list.state.message} onRetry={list.reload} />}
        {list.state.status === "ready" && list.state.data.length === 0 && <EmptyState title="Пользователей нет" />}
        {list.state.status === "ready" && list.state.data.length > 0 && (
          <ul className="divide-y divide-stroke rounded-card border border-stroke" aria-label="Пользователи">
            {list.state.data.map((u) => (
              <li key={u.id} className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 font-medium"><span className="truncate">{u.email}</span><Badge tone={u.active ? "success" : "danger"}>{u.active ? "Активен" : "Отключён"}</Badge><Badge tone="neutral">{u.role}</Badge></p>
                  <p className="tabular text-xs text-text-muted">{u.name || "без имени"}{u.createdAt && ` · с ${formatDateTimeUtc(u.createdAt)}`}</p>
                </div>
                <Button size="sm" variant={u.active ? "ghost" : "secondary"} disabled={busy === u.id} onClick={() => void toggle(u.id, !u.active)}>{u.active ? "Отключить" : "Включить"}</Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
