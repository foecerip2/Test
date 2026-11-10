"use client";
import { useState } from "react";
import { KanbanColumn } from "@/components/pipeline/KanbanColumn";
import { STAGES } from "@/components/pipeline/KanbanCard";
import { useToast } from "@/components/Toast";
import { Async, EmptyState, PageHeader } from "@/components/ui";
import { ApiError, getApi, type CrmStage } from "@/lib/api";
import { useDocumentTitle, useQuery } from "@/lib/hooks";
import s from "./pipeline.module.css";

export default function PipelinePage() {
  useDocumentTitle("Воронка продаж");
  const toast = useToast();
  const q = useQuery((a) => a.companies.list({ limit: 1000, sort: "score" }));
  const [busy, setBusy] = useState(false);

  async function move(id: string, stage: CrmStage) {
    const c = q.data?.items.find((x) => x.id === id);
    if (!c || c.stage === stage) return;
    setBusy(true);
    try { await getApi().companies.setStage(id, stage); toast(`«${c.name}» → ${STAGES.find((x) => x.id === stage)?.label}`); }
    catch (e) { toast(e instanceof ApiError ? e.message : "Не удалось изменить стадию", "error"); }
    finally { setBusy(false); }
  }

  return (
    <>
      <PageHeader eyebrow="ВОРОНКА / ПРОДАЖИ" title="Сделки и стадии" subtitle="Каждая компания проходит цепочку от поиска до пилота. Стадию можно менять списком в карточке или перетаскиванием." />
      <Async q={q} rows={6}>
        {(d) => d.total === 0 ? (
          <div className="panel"><EmptyState icon="columns" title="В воронке пока нет компаний" text="Импортируйте компании или запустите поиск — они появятся в стадии «Новые»." /></div>
        ) : (
          <div className={s.board}>
            {STAGES.map((st) => <KanbanColumn key={st.id} id={st.id} title={st.label} busy={busy} items={d.items.filter((c) => c.stage === st.id)} onMove={move} />)}
          </div>
        )}
      </Async>
    </>
  );
}
