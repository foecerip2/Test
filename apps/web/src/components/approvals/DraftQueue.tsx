"use client";
import { ScoreBadge, StatusTag } from "../ui";
import type { Draft } from "@/lib/api";

const LABEL: Record<Draft["status"], { t: string; tone: "amber" | "green" | "neutral" | "red" }> = {
  generated: { t: "Создан", tone: "neutral" }, editing: { t: "Правка", tone: "neutral" }, pending_review: { t: "Ожидает решения", tone: "amber" },
  approved: { t: "Согласован", tone: "green" }, rejected: { t: "Отклонён", tone: "red" },
};

export function DraftQueue({ drafts, selectedId, onSelect }: { drafts: Draft[]; selectedId: string | null; onSelect: (id: string) => void }) {
  return (
    <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }} aria-label="Очередь черновиков">
      {drafts.map((d) => {
        const st = LABEL[d.status];
        const sel = d.id === selectedId;
        return (
          <li key={d.id}>
            <button type="button" onClick={() => onSelect(d.id)} aria-current={sel ? "true" : undefined}
              style={{ width: "100%", textAlign: "left", minHeight: 56, padding: "10px 14px", borderRadius: 10, background: sel ? "var(--tint)" : "var(--paper)", border: `1px solid ${sel ? "#8fc4aa" : "var(--border)"}` }}>
              <span className="row between" style={{ gap: 8 }}><strong>{d.companyName}</strong><ScoreBadge score={d.score} /></span>
              <span className="row" style={{ marginTop: 6, gap: 8 }}><StatusTag tone={st.tone}>{st.t}</StatusTag>{d.approvalStale && <StatusTag tone="red">Устарело</StatusTag>}<span className="small muted">{d.city}</span></span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
