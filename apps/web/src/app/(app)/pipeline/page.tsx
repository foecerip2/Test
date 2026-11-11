"use client";
import Link from "next/link";
import { useCallback, useState } from "react";
import { KanbanColumn } from "@/components/pipeline/KanbanColumn";
import { STAGES } from "@/components/pipeline/KanbanCard";
import { useToast } from "@/components/Toast";
import { Async, EmptyState, PageHeader } from "@/components/ui";
import { ApiError, getApi, type Api, type Company, type CrmStage } from "@/lib/api";
import { useDocumentTitle, useQuery } from "@/lib/hooks";
import s from "./pipeline.module.css";

const BOARD_PAGE = 200; // максимум сервера на страницу
const BOARD_PAGES = 10; // защита от бесконечной загрузки: до 2000 компаний на доске

/** Доска строится по полному списку: подгружаем страницы по курсору, пока они есть. */
async function loadBoard(a: Api): Promise<{ items: Company[]; total: number; truncated: boolean }> {
  const items: Company[] = [];
  let cursor: string | undefined;
  let total = 0;
  let more = false;
  for (let i = 0; i < BOARD_PAGES; i++) {
    const p = await a.companies.list({ limit: BOARD_PAGE, sort: "score", cursor });
    items.push(...p.items);
    total = p.total;
    more = p.hasMore && !!p.nextCursor;
    if (!more) break;
    cursor = p.nextCursor ?? undefined;
  }
  return { items, total, truncated: more };
}

export default function PipelinePage() {
  useDocumentTitle("Воронка продаж");
  const toast = useToast();
  const q = useQuery(loadBoard);
  const [busy, setBusy] = useState(false);
  const [focusTo, setFocusTo] = useState<{ id: string; stage: CrmStage } | null>(null);
  const clearFocus = useCallback(() => setFocusTo(null), []);

  async function move(id: string, stage: CrmStage) {
    const c = q.data?.items.find((x) => x.id === id);
    if (!c || c.stage === stage) return;
    setBusy(true); setFocusTo({ id, stage });
    try { await getApi().companies.setStage(id, stage, c.stage); toast(`«${c.name}» перемещена в стадию «${STAGES.find((x) => x.id === stage)?.label}»`); }
    catch (e) { setFocusTo({ id, stage: c.stage }); toast(e instanceof ApiError ? e.message : "Не удалось изменить стадию", "error"); }
    finally { setBusy(false); }
  }

  return (
    <>
      <PageHeader eyebrow="ВОРОНКА / ПРОДАЖИ" title="Сделки и стадии" subtitle="Каждая компания проходит цепочку от поиска до пилота. Стадию можно менять списком в карточке или перетаскиванием." />
      <Async q={q} rows={6}>
        {(d) => d.total === 0 ? (
          <div className="panel"><EmptyState level={2} icon="columns" title="В воронке пока нет компаний" text="Загрузите CSV в разделе «База компаний» — импортированные компании появятся в стадии «Новые»." action={<Link className="btn btn-primary" href="/companies">Открыть базу компаний</Link>} /></div>
        ) : (
          <>
          {d.truncated && <p className="small muted" role="status">Показаны первые {d.items.length} из {d.total} компаний — остальные доступны в базе компаний.</p>}
          <div className={s.board}>
            {STAGES.map((st) => <KanbanColumn key={st.id} id={st.id} title={st.label} busy={busy} items={d.items.filter((c) => c.stage === st.id)} onMove={move} focusId={focusTo?.stage === st.id ? focusTo.id : null} onFocused={clearFocus} />)}
          </div>
          </>
        )}
      </Async>
    </>
  );
}
