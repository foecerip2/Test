"use client";
import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { CompanyTable, type SortKey } from "@/components/companies/CompanyTable";
import { ImportWizard } from "@/components/import/ImportWizard";
import { useToast } from "@/components/Toast";
import { Async, EmptyState, PageHeader, Panel } from "@/components/ui";
import { getApi, type CompanyFilter } from "@/lib/api";
import { useDocumentTitle, useQuery } from "@/lib/hooks";

const STATUSES = [
  ["new", "Новый"], ["awaiting_approval", "На согласовании"], ["approved", "Текст согласован"], ["contacted", "Контакт установлен"],
  ["question", "Вопрос"], ["interested", "Заинтересован"], ["pilot", "Пилот"], ["refused", "Отказ"], ["rejected", "Отклонена"],
] as const;
const PAGE = 10;

export default function CompaniesPage() {
  useDocumentTitle("База компаний");
  const toast = useToast();
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [city, setCity] = useState("");
  const [scoreMin, setScoreMin] = useState(0);
  const [status, setStatus] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "score", dir: "desc" });
  const [limit, setLimit] = useState(PAGE);
  const [importing, setImporting] = useState(false);

  useEffect(() => { const t = setTimeout(() => { setQuery(text); setLimit(PAGE); }, 250); return () => clearTimeout(t); }, [text]);

  const filter: CompanyFilter = { query, city: city || undefined, scoreMin: scoreMin || undefined, status: status || undefined, sort: sort.key, dir: sort.dir, limit };
  const q = useQuery((a) => a.companies.list(filter), [query, city, scoreMin, status, sort.key, sort.dir, limit]);
  const st = useQuery((a) => a.settings.get());
  const filtered = !!(query || city || scoreMin || status);

  function onSort(k: SortKey) { setSort((s) => (s.key === k ? { key: k, dir: s.dir === "asc" ? "desc" : "asc" } : { key: k, dir: k === "name" ? "asc" : "desc" })); }
  function reset() { setText(""); setQuery(""); setCity(""); setScoreMin(0); setStatus(""); setLimit(PAGE); }

  async function exportCsv() {
    try {
      const csv = await getApi().companies.exportCsv({ ...filter, limit: undefined });
      const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
      const a = document.createElement("a"); a.href = url; a.download = "leadhunter-companies.csv"; a.click(); URL.revokeObjectURL(url);
      toast("CSV выгружен");
    } catch { toast("Не удалось выгрузить CSV", "error"); }
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
        <select className="select" aria-label="Город" value={city} onChange={(e) => { setCity(e.target.value); setLimit(PAGE); }}>
          <option value="">Все города</option>{q.data?.cities.map((c) => <option key={c}>{c}</option>)}
        </select>
        <select className="select" aria-label="Минимальная оценка" value={scoreMin} onChange={(e) => { setScoreMin(Number(e.target.value)); setLimit(PAGE); }}>
          <option value={0}>Все оценки</option><option value={50}>От 50 баллов</option><option value={75}>От 75 баллов</option><option value={90}>От 90 баллов</option>
        </select>
        <select className="select" aria-label="Статус" value={status} onChange={(e) => { setStatus(e.target.value); setLimit(PAGE); }}>
          <option value="">Все статусы</option>{STATUSES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <button className="btn" onClick={exportCsv}><Icon name="download" /> Экспорт CSV</button>
      </div>
      <Panel title="Найденные организации" subtitle={q.data ? `Показано ${q.data.items.length} из ${q.data.total}` : undefined}>
        <Async q={q} rows={6}>
          {(d) => d.items.length === 0 ? (
            filtered
              ? <EmptyState icon="search" title="Ничего не найдено" text="Попробуйте изменить условия поиска." action={<button className="btn" onClick={reset}>Сбросить фильтры</button>} />
              : <EmptyState icon="building" title="База пока пуста" text="Импортируйте CSV или запустите кампанию на странице «Поиск компаний»." action={<button className="btn btn-primary" onClick={() => setImporting(true)}>Импорт CSV</button>} />
          ) : (
            <>
              <CompanyTable items={d.items} caption="Найденные организации" threshold={st.data?.scoreThreshold ?? 75} sort={sort} onSort={onSort} />
              {d.hasMore && <div style={{ padding: 16, textAlign: "center" }}><button className="btn" onClick={() => setLimit((l) => l + PAGE)}>Показать ещё</button></div>}
            </>
          )}
        </Async>
      </Panel>
      {importing && <ImportWizard onClose={() => setImporting(false)} />}
    </>
  );
}
