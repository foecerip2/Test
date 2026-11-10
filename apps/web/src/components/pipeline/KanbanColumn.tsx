"use client";
import { useState } from "react";
import { KanbanCard } from "./KanbanCard";
import type { Company, CrmStage } from "@/lib/api";

export function KanbanColumn({ id, title, items, busy, onMove, focusId, onFocused }: { id: CrmStage; title: string; items: Company[]; busy: boolean; onMove: (companyId: string, stage: CrmStage) => void; focusId?: string | null; onFocused?: () => void }) {
  const [over, setOver] = useState(false);
  return (
    <section aria-labelledby={`col-${id}`} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); const cid = e.dataTransfer.getData("text/plain"); if (cid) onMove(cid, id); }}
      style={{ background: "#f0f3ef", borderRadius: 10, padding: 12, minWidth: 0, outline: over ? "2px dashed var(--accent)" : undefined }}>
      <h2 id={`col-${id}`} style={{ fontSize: "0.8125rem", display: "flex", justifyContent: "space-between", padding: "4px 4px 12px" }}>
        <span>{title}</span><span className="muted"><span className="sr-only">, компаний: </span>{items.length}</span>
      </h2>
      <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
        {items.map((c) => <KanbanCard key={c.id} company={c} busy={busy} focus={focusId === c.id} onFocused={onFocused} onMove={(st) => onMove(c.id, st)} />)}
        {items.length === 0 && <p className="muted small" style={{ textAlign: "center", padding: "20px 0" }}>Пока пусто</p>}
      </div>
    </section>
  );
}
