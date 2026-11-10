"use client";
import { useState } from "react";
import { Icon } from "../Icon";
import { useToast } from "../Toast";
import { Field, Notice, Panel } from "../ui";
import { ApiError, getApi, type SourceConfig } from "@/lib/api";
import m from "./discovery.module.css";

export const REGIONS = [
  "Москва", "Санкт-Петербург", "Казань", "Екатеринбург", "Новосибирск", "Нижний Новгород", "Самара",
  "Ростов-на-Дону", "Краснодар", "Уфа", "Воронеж", "Красноярск", "Пермь", "Челябинск",
];
const CATEGORIES = ["Автосервисы и СТО", "Шиномонтажи", "Кузовной ремонт", "Детейлинг", "Автомойки"];

export function CampaignForm({ sources }: { sources: SourceConfig[] }) {
  const toast = useToast();
  const firstEnabled = sources.find((s) => s.enabled)?.id ?? "";
  const [name, setName] = useState("");
  const [regions, setRegions] = useState<string[]>([]);
  const [cats, setCats] = useState<string[]>([CATEGORIES[0]!]);
  const [sourceId, setSourceId] = useState(firstEnabled);
  const [limit, setLimit] = useState("50");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const toggle = (list: string[], v: string, set: (l: string[]) => void) => set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const allSelected = regions.length === REGIONS.length;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const er: Record<string, string> = {};
    if (!name.trim()) er.name = "Укажите название кампании";
    if (!regions.length) er.regions = "Выберите хотя бы один регион";
    if (!cats.length) er.cats = "Выберите хотя бы одну категорию";
    const lim = Number(limit);
    if (!Number.isInteger(lim) || lim < 1 || lim > 500) er.limit = "Лимит — целое число от 1 до 500";
    if (!sourceId) er.source = "Нет доступного источника";
    setErrors(er);
    const firstBad = Object.keys(er)[0];
    if (firstBad) {
      // Переносим фокус к первому полю с ошибкой (WCAG 3.3.1).
      const target = ({ name: "c-name", regions: "c-regions-all", cats: "c-cats-first", limit: "c-limit", source: "c-source" } as Record<string, string>)[firstBad];
      setTimeout(() => document.getElementById(target ?? "")?.focus(), 0);
      return;
    }
    setBusy(true);
    try {
      await getApi().campaigns.create({ name: name.trim(), regions, categories: cats, sourceId, perDayLimit: lim });
      toast("Кампания создана");
      setName(""); setRegions([]);
    } catch (x) {
      toast(x instanceof ApiError ? x.message : "Не удалось создать кампанию", "error");
    } finally { setBusy(false); }
  }

  return (
    <Panel title="Новая кампания" subtitle="Параметры задания для фонового обработчика" action={<Icon name="filter" />}>
      <form className="panel-body" onSubmit={submit} noValidate>
        <Field label="Название" htmlFor="c-name" error={errors.name}>
          <input id="c-name" className="input" value={name} onChange={(e) => setName(e.target.value)} aria-invalid={!!errors.name} maxLength={80} />
        </Field>

        <fieldset className="field" style={{ border: 0, padding: 0, margin: "0 0 18px" }} aria-describedby={errors.regions ? "regions-err" : undefined}>
          <legend className="field-label">Регионы</legend>
          <div className="choice-row" style={{ marginBottom: 10 }}>
            <button type="button" id="c-regions-all" className="btn btn-sm" onClick={() => setRegions(allSelected ? [] : [...REGIONS])}>
              {allSelected ? "Снять выбор" : "Вся Россия (все города из списка)"}
            </button>
          </div>
          <div className="choice-row">
            {REGIONS.map((r) => (
              <label key={r} className={m.check}>
                <input type="checkbox" checked={regions.includes(r)} onChange={() => toggle(regions, r, setRegions)} />
                {r}
              </label>
            ))}
          </div>
          <p className="field-hint">Поиск идёт итеративно по городам, а не по всей стране сразу.</p>
          {errors.regions && <p className="field-error" id="regions-err" role="alert">{errors.regions}</p>}
        </fieldset>

        <fieldset className="field" style={{ border: 0, padding: 0, margin: "0 0 18px" }} aria-describedby={errors.cats ? "cats-err" : undefined}>
          <legend className="field-label">Категории</legend>
          <div className="choice-row">
            {CATEGORIES.map((c, i) => (
              <label key={c} className={m.check}>
                <input type="checkbox" id={i === 0 ? "c-cats-first" : undefined} checked={cats.includes(c)} onChange={() => toggle(cats, c, setCats)} />
                {c}
              </label>
            ))}
          </div>
          {errors.cats && <p className="field-error" id="cats-err" role="alert">{errors.cats}</p>}
        </fieldset>

        <Field label="Источник данных" htmlFor="c-source" error={errors.source}>
          <select id="c-source" className="select" value={sourceId} onChange={(e) => setSourceId(e.target.value)} aria-describedby="c-source-hint">
            {sources.map((s) => (
              <option key={s.id} value={s.id} disabled={!s.enabled}>{s.name}{!s.enabled ? " — недоступен" : ""}</option>
            ))}
          </select>
          <ul className="field-hint" id="c-source-hint" style={{ paddingLeft: 18 }}>
            {sources.filter((s) => !s.enabled).map((s) => <li key={s.id}><strong>{s.name}:</strong> {s.disabledReason}</li>)}
          </ul>
        </Field>

        <Field label="Лимит компаний в сутки" htmlFor="c-limit" error={errors.limit}>
          <input id="c-limit" className="input" inputMode="numeric" value={limit} onChange={(e) => setLimit(e.target.value)} aria-invalid={!!errors.limit} style={{ maxWidth: 140 }} />
        </Field>

        <Notice>Поиск не должен обходить CAPTCHA, блокировки сайтов или условия использования каталогов. Каталоги подключаются только после проверки лицензии — сейчас доступен импорт ваших данных.</Notice>
        <div className="spacer-top"><button className="btn btn-primary" disabled={busy}><Icon name="radar" /> Создать кампанию</button></div>
      </form>
    </Panel>
  );
}
