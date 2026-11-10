"use client";
import { useState } from "react";
import { Icon } from "../Icon";
import { useToast } from "../Toast";
import { EmptyState, Panel, StatusTag } from "../ui";
import { ApiError, getApi, type Campaign } from "@/lib/api";
import { fmtDay } from "@/lib/hooks";

const LABEL = { running: "Выполняется", paused: "На паузе", done: "Завершена" } as const;
const TONE = { running: "green", paused: "amber", done: "neutral" } as const;

export function CampaignList({ campaigns }: { campaigns: Campaign[] }) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  async function toggle(k: Campaign) {
    setBusy(k.id);
    try { await getApi().campaigns.setStatus(k.id, k.status === "running" ? "paused" : "running"); toast(k.status === "running" ? "Кампания поставлена на паузу" : "Кампания возобновлена"); }
    catch (x) { toast(x instanceof ApiError ? x.message : "Не удалось изменить статус", "error"); }
    finally { setBusy(null); }
  }
  return (
    <Panel title="Кампании" subtitle="Поисковые задания по регионам">
      {campaigns.length === 0 ? <EmptyState icon="radar" title="Кампаний пока нет" text="Создайте первую кампанию или импортируйте компании из CSV." /> : (
        <ul className="feed">
          {campaigns.map((k) => (
            <li key={k.id} className="feed-item" style={{ flexWrap: "wrap" }}>
              <div className="feed-text" style={{ flex: 1, minWidth: 220 }}>
                <strong>{k.name}</strong>
                <p>{k.regions.length > 3 ? `${k.regions.slice(0, 3).join(", ")} и ещё ${k.regions.length - 3}` : k.regions.join(", ")} · {k.categories.join(", ")}</p>
                <p>Создана {fmtDay(k.createdAt)} · до {k.perDayLimit} компаний в сутки · обработано {k.progress.done}{k.progress.total ? ` из ${k.progress.total}` : ""}</p>
              </div>
              <div className="row">
                <StatusTag tone={TONE[k.status]}>{LABEL[k.status]}</StatusTag>
                {k.status !== "done" && (
                  <button className="btn btn-sm" disabled={busy === k.id} onClick={() => toggle(k)}>
                    <Icon name={k.status === "running" ? "pause" : "play"} /> {k.status === "running" ? "Пауза" : "Продолжить"}<span className="sr-only">: {k.name}</span>
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
