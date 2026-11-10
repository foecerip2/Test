"use client";
import { StatusTag } from "../ui";
import { fmtRel } from "@/lib/hooks";
import { STAGE_LABEL } from "@/lib/classify";
import type { Conversation, Tone } from "@/lib/api";

export const stageTone = (s: Conversation["stage"]): Tone =>
  s === "interested" ? "green" : s === "unsubscribe" || s === "not_interested" ? "red" : s === "question" || s === "ambiguous" || s === "later" ? "amber" : "neutral";

export function ConversationList({ items, selectedId, onSelect }: { items: Conversation[]; selectedId: string | null; onSelect: (id: string) => void }) {
  return (
    <ul style={{ listStyle: "none", margin: 0, padding: 0 }} aria-label="Диалоги">
      {items.map((c) => {
        const sel = c.id === selectedId;
        return (
          <li key={c.id}>
            <button type="button" onClick={() => onSelect(c.id)} aria-current={sel ? "true" : undefined}
              style={{ width: "100%", textAlign: "left", border: 0, borderBottom: "1px solid var(--border)", borderLeft: `3px solid ${sel ? "var(--accent)" : "transparent"}`, background: sel ? "#f0f7f2" : "var(--paper)", padding: "14px 16px", minHeight: 88, display: "block" }}>
              <span className="row between" style={{ gap: 8, flexWrap: "nowrap" }}>
                <strong>{c.companyName}</strong>
                <span className="small muted" style={{ whiteSpace: "nowrap" }}>{fmtRel(c.lastMessageAt)}</span>
              </span>
              <span className="small muted" style={{ display: "block", margin: "5px 0 8px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.preview}</span>
              <span className="row" style={{ gap: 8 }}>
                <StatusTag tone={stageTone(c.stage)}>{STAGE_LABEL[c.stage]}</StatusTag>
                {c.unread && <StatusTag tone="amber">Новое</StatusTag>}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
