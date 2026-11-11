"use client";
import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { CompanyTable, type SortKey } from "@/components/companies/CompanyTable";
import { ImportWizard } from "@/components/import/ImportWizard";
import { useToast } from "@/components/Toast";
import { Async, EmptyState, PageHeader, Panel } from "@/components/ui";
import { ApiError, getApi, type Company, type CompanyFilter } from "@/lib/api";
import { useDocumentTitle, useQuery } from "@/lib/hooks";

/** Статусы фильтра. В рабочем режиме — те, что понимает сервер (display.key); в демо — расширенный набор mock. */
const STATUSES_MOCK = [
  ["new", "Новый"], ["awaiting_approval", "На согласовании"], ["approved", "Текст согласован"], ["contacted", "Контакт установлен"],
  ["question", "Вопрос"], ["interested", "Заинтересован"], ["pilot", "Пилот"], ["refused", "Отказ"], ["rejected", "Отклонена"],
] as const;
const STATUSES_LIVE = [
  ["new", "Новый"], ["contacted", "Контакт установлен"], ["replied", "Ответила"], ["interested", "Заинтересован"],
  ["pilot", "Пилот"], ["refused", "Отказ"], ["rejected", "Отклонена"],
] as const;

interface More { items: Company[]; hasMore: boolean; cursor: string | null }

export default function CompaniesPage() {
  useDocumentTitle("База компаний");
  const toast = useToast();
  const live = process.env.NEXT_PUBLIC_DATA_MODE === "live";
  const PAGE = live ? 50 : 10;
  const STATUSES = live ? STATUSES_LIVE : STATUSES_MOCK;
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [city, setCity] = useState("");
  const [scoreMin, setScoreMin] = useState(0);
  const [status, setStatus] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "score", dir: "desc" });
  const [more, setMore] = useState<More | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [importing, setImporting] = useState(false);

  useEffect(() => { const t = setTimeout(() => setQuery(text), 250); return () => clearTimeout(t); }, [text]);

  const filter: CompanyFilter = { query, city: city || undefined, scoreMin: scoreMin || undefined, status: status || undefined, sort: sort.key, dir: sort.dir };
  const q = useQuery((a) => a.companies.list({ ...filter, limit: PAGE }), [query, city, scoreMin, status, sort.key, sort.dir]);
  const st = useQuery(async (a) => (a.mode === "live" ? null : a.settings.get()));
  const sm = useQuery(async (a) => (a.mode === "live" ? a.summary() : null));
  const threshold = sm.data?.scoreThreshold ?? st.data?.scoreThreshold ?? 75;
  const filtered = !!(query || city || scoreMin || status);
  // Любая новая первая страница (другие фильтры, обновление после правок) сбрасывает дозагруженные страницы.
  useEffect(() => { setMore(null); }, [q.data]);

  function onSort(k: SortKey) { setSort((s) => (s.key === k ? { key: k, dir: s.dir === "asc" ? "desc" : "asc" } : { key: k, dir: k === "name" ? "asc" : "desc" })); }
  function reset() { setText(""); setQuery(""); setCity(""); setScoreMin(0); setStatus(""); }

  const loadMore = useCallback(async (cursor: string | null) => {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const p = await getApi().companies.list({ ...filter, limit: PAGE, cursor });
      setMore((m) => ({ items: [...(m?.items ?? []), ...p.items], hasMore: p.hasMore, cursor: p.nextCursor }));
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Не удалось загрузить ещё", "error");
      if (e instanceof ApiError && e.code === "INVALID_CURSOR") q.reload();
    } finally { setLoadingMore(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, city, scoreMin, status, sort.key, sort.dir, PAGE]);

  async function exportCsv() {
    try {
      const csv = await getApi().companies.exportCsv(filter);
      const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
      const a = document.createElement("a"); a.href = url; a.download = "leadhunter-companies.csv"; a.click(); URL.revokeObjectURL(url);
      toast("CSV выгружен");
    } catch (e) { toast(e instanceof ApiError ? e.message : "Не удалось выгрузить CSV", "error"); }
  }

  return (
    <>
      <PageHeader eyebrow="Компании / квалификация" title="База компаний" subtitle="Источники, доказательства, оценка и история контактов."
        actions={<button className="btn" onClick={() => setImporting(true)}><Icon name="download" /> Импорт CSV</button>} />
      <div className="toolbar" role="search">
        <div className="input-search"><Icon name="search" />
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Компания, город, специализация…" aria-label="Поиск по компаниям" />
        </div>
        <select className="select only-mobile" aria-label="Сортировка" value={`${sort.key}:${sort.dir}`} onChange={(e) => { const [k, d] = e.target.value.split(":"); setSort({ key: k as SortKey, dir: d as "asc" | "desc" }); }}>
          <option value="score:desc">Сначала высокая оценка</option><option value="score:asc">Сначала низкая оценка</option><option value="name:asc">По названию А–Я</option><option value="updated:desc">Недавно обновлённые</option>
        </select>
        <select className="select" aria-label="Город" value={city} onChange={(e) => setCity(e.target.value)}>
          <option value="">Все города</option>{q.data?.cities.map((c) => <option key={c}>{c}</option>)}
        </select>
        <select className="select" aria-label="Минимальная оценка" value={scoreMin} onChange={(e) => setScoreMin(Number(e.target.value))}>
          <option value={0}>Все оценки</option><option value={50}>От 50 баллов</option><option value={75}>От 75 баллов</option><option value={90}>От 90 баллов</option>
        </select>
        <select className="select" aria-label="Статус" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Все статусы</option>{STATUSES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <button className="btn" onClick={exportCsv}><Icon name="download" /> Экспорт CSV</button>
      </div>
      <Panel title="Найденные организации" subtitle={q.data ? `Показано ${q.data.items.length + (more?.items.length ?? 0)} из ${q.data.total}` : undefined}>
        <Async q={q} rows={6}>
          {(d) => d.items.length === 0 ? (
            filtered
              ? <EmptyState icon="search" title="Ничего не найдено" text="Попробуйте изменить условия поиска." action={<button className="btn" onClick={reset}>Сбросить фильтры</button>} />
              : live
                ? <EmptyState icon="upload" title="Загрузите свой CSV" text="В базе пока нет компаний. Загрузите файл со списком — они появятся здесь с оценкой и историей." action={<button className="btn btn-primary" onClick={() => setImporting(true)}>Импорт CSV</button>} />
                : <EmptyState icon="building" title="База пока пуста" text="Импортируйте CSV или запустите кампанию на странице «Поиск компаний»." action={<button className="btn btn-primary" onClick={() => setImporting(true)}>Импорт CSV</button>} />
          ) : (
            <>
              <CompanyTable items={[...d.items, ...(more?.items ?? [])]} caption="Найденные организации" threshold={threshold} sort={sort} onSort={onSort} />
              {(more ? more.hasMore : d.hasMore) && (
                <div style={{ padding: 16, textAlign: "center" }}>
                  <button className="btn" disabled={loadingMore} onClick={() => loadMore(more ? more.cursor : d.nextCursor)}>{loadingMore ? "Загружаем…" : "Показать ещё"}</button>
                </div>
              )}
            </>
          )}
        </Async>
      </Panel>
      {importing && <ImportWizard onClose={() => setImporting(false)} />}
    </>
  );
}
