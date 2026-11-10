"use client";
import { useState } from "react";
import { ConfirmDialog } from "../Modal";
import { Icon } from "../Icon";
import { useToast } from "../Toast";
import { EmptyState, Panel, StatusTag } from "../ui";
import { ApiError, getApi, type Job } from "@/lib/api";
import { fmtRel } from "@/lib/hooks";

const LABEL: Record<Job["state"], string> = { queued: "В очереди", running: "Выполняется", succeeded: "Готово", failed: "Ошибка", cancelled: "Отменена" };
const TONE: Record<Job["state"], "neutral" | "green" | "amber" | "red"> = { queued: "neutral", running: "amber", succeeded: "green", failed: "red", cancelled: "neutral" };
const ICON: Record<Job["type"], string> = { discover: "radar", enrich: "refresh", score: "chart", import: "download" };

export function JobQueue({ jobs }: { jobs: Job[] }) {
  const toast = useToast();
  const [target, setTarget] = useState<Job | null>(null);
  const [busy, setBusy] = useState(false);
  async function cancel() {
    if (!target) return;
    setBusy(true);
    try { await getApi().jobs.cancel(target.id); toast("Задача отменена"); }
    catch (x) { toast(x instanceof ApiError ? x.message : "Не удалось отменить задачу", "error"); }
    finally { setBusy(false); setTarget(null); }
  }
  return (
    <Panel title="Очередь задач" subtitle="Состояние фоновых процессов">
      {jobs.length === 0 ? <EmptyState icon="clock" title="Задач нет" text="Задачи появятся после запуска кампании или импорта." /> : (
        <ul className="feed">
          {jobs.map((j) => (
            <li key={j.id} className="feed-item" style={{ flexWrap: "wrap" }}>
              <span className="feed-icon"><Icon name={ICON[j.type]} /></span>
              <div className="feed-text" style={{ flex: 1, minWidth: 180 }}>
                <strong>{j.label}</strong>
                <p>Обновлено {fmtRel(j.updatedAt)}{j.retries ? ` · повторов: ${j.retries}` : ""}</p>
                {j.lastError && <p style={{ color: "var(--red)", fontWeight: 600 }}>Ошибка: {j.lastError}</p>}
              </div>
              <div className="row">
                <StatusTag tone={TONE[j.state]}>{LABEL[j.state]}</StatusTag>
                {(j.state === "queued" || j.state === "running") && <button className="btn btn-sm" onClick={() => setTarget(j)} aria-label={`Отменить задачу: ${j.label}`}>Отменить</button>}
              </div>
            </li>
          ))}
        </ul>
      )}
      {target && <ConfirmDialog title="Отменить задачу?" text={<>Задача «{target.label}» будет остановлена. Уже обработанные данные сохранятся.</>} confirmLabel="Отменить задачу" danger busy={busy} onConfirm={cancel} onCancel={() => setTarget(null)} />}
    </Panel>
  );
}
