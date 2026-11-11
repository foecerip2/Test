/**
 * Паритет TS-эталона с Python-реализацией (apps/api/app/services/{normalize,scoring}.py).
 * Обе стороны читают одни и те же фикстуры apps/api/tests/fixtures/*.json:
 * здесь проверяется TypeScript, в apps/api/tests/test_parity.py — Python.
 * Если правило меняется, фикстуры обновляются вместе с обеими реализациями.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalDomain, csvCell, mapImportRows, normalizeCity, normalizeInn, normalizeName, parseCsv, titleCaseCity, toCsv } from "@/lib/normalize";
import { SCORE_RULE_VERSION, scoreCompany, type ScoreInput } from "@/lib/scoring";

const FIXTURES = fileURLToPath(new URL("../../api/tests/fixtures/", import.meta.url));
const load = <T>(name: string): T => JSON.parse(readFileSync(`${FIXTURES}${name}.json`, "utf-8")) as T;

interface Case<I, O> { in: I; out: O }

function table<I, O>(title: string, file: string, fn: (i: I) => O) {
  describe(title, () => {
    const cases = load<Case<I, O>[]>(file);
    it("есть случаи", () => expect(cases.length).toBeGreaterThan(0));
    it.each(cases.map((c, i) => [i, JSON.stringify(c.in).slice(0, 40), c] as const))("#%i %s", (_i, _t, c) => {
      expect(fn(c.in)).toEqual(c.out);
    });
  });
}

table("normalizeName", "normalize_name", normalizeName);
table("normalizeCity", "normalize_city", normalizeCity);
table("titleCaseCity", "title_case_city", titleCaseCity);
table<string | null, string | null>("canonicalDomain", "canonical_domain", canonicalDomain);
table<string | null, string | null>("normalizeInn", "normalize_inn", normalizeInn);
table("parseCsv", "parse_csv", parseCsv);
table<string | number, string>("csvCell", "csv_cell", csvCell);
table<(string | number)[][], string>("toCsv", "to_csv", toCsv);

describe("mapImportRows", () => {
  interface MapCase { name: string; table: string[][]; existing: { name: string; city: string; domain: string | null; inn?: string | null }[]; out: { rows: unknown[]; missingColumns: string[] } }
  const cases = load<MapCase[]>("map_import_rows");
  it.each(cases.map((c) => [c.name, c] as const))("%s", (_n, c) => {
    const r = mapImportRows(c.table, c.existing);
    // JSON не хранит undefined: сравниваем через сериализацию, как это видит Python.
    expect(JSON.parse(JSON.stringify({ rows: r.rows, missingColumns: r.missingColumns }))).toEqual(c.out);
  });
});

describe("scoreCompany", () => {
  interface ScoreCase { name: string; input: ScoreInput; score: number; reasons: unknown[] }
  const fx = load<{ rule_version: string; cases: ScoreCase[] }>("scoring");
  it("версия правил совпадает", () => expect(SCORE_RULE_VERSION).toBe(fx.rule_version));
  it.each(fx.cases.map((c) => [c.name, c] as const))("%s", (_n, c) => {
    const r = scoreCompany(c.input);
    expect(r.score).toBe(c.score);
    expect(r.reasons).toEqual(c.reasons);
  });
});
