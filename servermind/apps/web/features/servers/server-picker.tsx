"use client";

import { Select } from "@/components/ui/input";
import type { ServerSummary } from "@/lib/types";

const LABEL = { online: "онлайн", offline: "недоступен", checking: "проверка", unknown: "нет данных" } as const;

/** Выбор сервера. Нативный select — лучший вариант для мобильных и клавиатуры. */
export function ServerPicker({
  servers, value, onChange, label = "Сервер", id, className,
}: { servers: ServerSummary[]; value: string; onChange: (id: string) => void; label?: string; id?: string; className?: string }) {
  return (
    <Select aria-label={label} id={id} value={value} onChange={(e) => onChange(e.target.value)} className={className}>
      {servers.length === 0 && <option value="">Нет серверов</option>}
      {servers.map((s) => (
        <option key={s.id} value={s.id}>{s.name} — {LABEL[s.status]}</option>
      ))}
    </Select>
  );
}
