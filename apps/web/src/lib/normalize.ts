/** Нормализация и разбор данных импорта. Чистые функции — покрыты unit-тестами. */

// \b не работает с кириллицей в JS, поэтому границы слов задаются через lookaround.
const LEGAL_FORMS = /(?<![а-яёa-z0-9])(ооо|оао|зао|пао|ип|ао|llc|ltd)(?![а-яёa-z0-9])/gi;

export function normalizeName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[«»"'“”„]/g, " ")
    .replace(LEGAL_FORMS, " ")
    .replace(/[^a-zа-я0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function normalizeCity(raw: string): string {
  const s = raw
    .trim()
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/^(г\.?|город)\s+/, "")
    .replace(/\s+/g, " ");
  const alias: Record<string, string> = { спб: "санкт-петербург", питер: "санкт-петербург", "санкт петербург": "санкт-петербург", мск: "москва", екб: "екатеринбург", "н.новгород": "нижний новгород" };
  return alias[s] ?? s;
}

export function titleCaseCity(norm: string): string {
  return norm.replace(/(^|[\s-])([а-яa-z])/g, (_, p: string, c: string) => p + c.toUpperCase());
}

/** Канонический домен: без схемы, www, пути и порта. Возвращает null для невалидного значения. */
export function canonicalDomain(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.trim().toLowerCase();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(s)) s = "http://" + s;
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    const host = u.hostname.replace(/^www\./, "");
    if (!host.includes(".") || !/^[a-z0-9.-]+$/.test(host.replace(/[а-яё]/g, "a"))) return null;
    return host;
  } catch {
    return null;
  }
}

export function normalizeInn(raw: string | null | undefined): string | null {
  const d = (raw ?? "").replace(/\D/g, "");
  return d.length === 10 || d.length === 12 ? d : null;
}

/** Разбор CSV (RFC 4180): кавычки, экранирование "", BOM, разделители `;` `,` табуляция. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const firstLine = src.split(/\r?\n/, 1)[0] ?? "";
  const counts: Record<string, number> = { ";": 0, ",": 0, "\t": 0 };
  let inQ = false;
  for (const ch of firstLine) {
    if (ch === '"') inQ = !inQ;
    else if (!inQ && ch in counts) counts[ch] = (counts[ch] ?? 0) + 1;
  }
  const delim = (Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0]) ?? ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  inQ = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (inQ) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; } else inQ = false;
      } else cell += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === delim) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== "")) rows.push(row);
  return rows;
}

/** Защита от CSV-инъекций при экспорте: значения, начинающиеся с = + - @, получают апостроф. */
export function csvCell(v: string | number): string {
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replaceAll('"', '""') + '"';
}

export function toCsv(rows: (string | number)[][]): string {
  return "﻿" + rows.map((r) => r.map(csvCell).join(";")).join("\r\n");
}

export interface ImportRow {
  line: number;
  name: string;
  city: string;
  category: string;
  website: string | null;
  inn: string | null;
  issues: string[];
  /** "exact" — ИНН/домен+город совпали; "candidate" — похожее название в том же городе (ручная проверка) */
  duplicate: null | { kind: "exact" | "candidate" | "in_file"; of: string };
}

const HEADERS: Record<string, string[]> = {
  name: ["name", "название", "компания", "наименование", "организация"],
  city: ["city", "город", "населенный пункт"],
  category: ["category", "категория", "тип", "вид деятельности"],
  website: ["website", "site", "сайт", "url", "домен"],
  inn: ["inn", "инн"],
};

export interface ExistingCompany { name: string; city: string; domain: string | null; inn?: string | null }

export function mapImportRows(table: string[][], existing: ExistingCompany[]): { rows: ImportRow[]; missingColumns: string[] } {
  const header = (table[0] ?? []).map((h) => h.trim().toLowerCase().replace(/ё/g, "е"));
  const idx = (key: string) => header.findIndex((h) => HEADERS[key]!.includes(h));
  const col = { name: idx("name"), city: idx("city"), category: idx("category"), website: idx("website"), inn: idx("inn") };
  const missingColumns = (["name", "city"] as const).filter((k) => col[k] < 0).map((k) => (k === "name" ? "название" : "город"));
  if (missingColumns.length) return { rows: [], missingColumns };

  const seen = new Map<string, string>();
  const rows: ImportRow[] = table.slice(1).map((cells, i) => {
    const get = (c: number) => (c >= 0 ? (cells[c] ?? "").trim() : "");
    const name = get(col.name);
    const cityNorm = normalizeCity(get(col.city));
    const website = canonicalDomain(get(col.website));
    const inn = normalizeInn(get(col.inn));
    const issues: string[] = [];
    if (!name) issues.push("Нет названия");
    if (!cityNorm) issues.push("Нет города");
    if (get(col.website) && !website) issues.push("Некорректный сайт");
    if (get(col.inn) && !inn) issues.push("Некорректный ИНН");

    let duplicate: ImportRow["duplicate"] = null;
    const nameNorm = normalizeName(name);
    // Порядок дедупликации по ТЗ §6: ИНН → домен+город → похожее название в городе (только кандидат, не слияние)
    const byInn = inn ? existing.find((e) => e.inn === inn) : undefined;
    const byDomain = website ? existing.find((e) => e.domain === website && normalizeCity(e.city) === cityNorm) : undefined;
    const byName = nameNorm ? existing.find((e) => normalizeName(e.name) === nameNorm && normalizeCity(e.city) === cityNorm) : undefined;
    if (byInn) duplicate = { kind: "exact", of: byInn.name };
    else if (byDomain) duplicate = { kind: "exact", of: byDomain.name };
    else if (byName) duplicate = { kind: "candidate", of: byName.name };
    const key = inn ?? (website ? `${website}|${cityNorm}` : `${nameNorm}|${cityNorm}`);
    if (!duplicate && !issues.length && seen.has(key)) duplicate = { kind: "in_file", of: seen.get(key)! };
    if (!issues.length && !seen.has(key)) seen.set(key, name);

    return { line: i + 2, name, city: titleCaseCity(cityNorm), category: get(col.category) || "Автосервис", website, inn, issues, duplicate };
  });
  return { rows, missingColumns };
}
