"use client";
import Link from "next/link";
import { useEffect, useRef } from "react";
import { ScoreBadge, StatusTag } from "../ui";
import type { Company, CrmStage } from "@/lib/api";

export const STAGES: { id: CrmStage; label: string }[] = [
  { id: "new", label: "Новые" }, { id: "contacted", label: "Контакт" }, { id: "replied", label: "Ответили" },
  { id: "interested", label: "Заинтересованы" }, { id: "pilot", label: "Пилот" }, { id: "lost", label: "Отказ" },
];

export function KanbanCard({ company, onMove, busy, focus, onFocused }: { company: Company; onMove: (stage: CrmStage) => void; busy: boolean; focus?: boolean; onFocused?: () => void }) {
  const sid = `stage-${company.id}`;
  const sel = useRef<HTMLSelectElement>(null);
  // После смены стадии карточка перемонтируется в другой колонке — возвращаем фокус на её список.
  useEffect(() => { if (focus && !busy && sel.current) { sel.current.focus(); onFocused?.(); } }, [focus, busy, onFocused]);
  return (
    <div draggable onDragStart={(e) => { e.dataTransfer.setData("text/plain", company.id); e.dataTransfer.effectAllowed = "move"; }}
      style={{ border: "1px solid var(--border)", borderRadius: 8, background: "var(--paper)", padding: 14 }}>
      <strong style={{ display: "block" }}>{company.name}</strong>
      <p className="small muted" style={{ margin: "3px 0 8px" }}>{company.city}</p>
      <div className="row" style={{ gap: 8, marginBottom: 10 }}><ScoreBadge score={company.score} /><StatusTag status={company.display} /></div>
      <label className="sr-only" htmlFor={sid}>Стадия: {company.name}</label>
      <select id={sid} ref={sel} className="select" value={company.stage} disabled={busy} onChange={(e) => onMove(e.target.value as CrmStage)}>
        {STAGES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
      </select>
      <div style={{ marginTop: 8 }}><Link className="link-btn" href={`/companies/${company.id}`}>Карточка<span className="sr-only"> компании {company.name}</span> <span aria-hidden="true">→</span></Link></div>
    </div>
  );
}
