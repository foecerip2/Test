import { describe, expect, it } from "vitest";
import { canonicalDomain, csvCell, mapImportRows, normalizeCity, normalizeInn, normalizeName, parseCsv, toCsv } from "@/lib/normalize";

describe("normalizeName", () => {
  it("убирает кавычки, формы собственности, регистр и ё", () => {
    expect(normalizeName("ООО «Мотор-Лайн»")).toBe("мотор лайн");
    expect(normalizeName('  СТО  "Ёжик"  ')).toBe("сто ежик");
  });
});

describe("normalizeCity", () => {
  it("приводит псевдонимы", () => {
    expect(normalizeCity("г. Москва")).toBe("москва");
    expect(normalizeCity("СПб")).toBe("санкт-петербург");
    expect(normalizeCity("  Казань ")).toBe("казань");
  });
});

describe("canonicalDomain", () => {
  it("извлекает домен без схемы, www, пути", () => {
    expect(canonicalDomain("https://www.Example.com/path?q=1")).toBe("example.com");
    expect(canonicalDomain("sever-motor.example")).toBe("sever-motor.example");
  });
  it("отвергает мусор и не-http схемы", () => {
    expect(canonicalDomain("")).toBeNull();
    expect(canonicalDomain("localhost")).toBeNull();
    expect(canonicalDomain("ftp://example.com")).toBeNull();
    expect(canonicalDomain("javascript:alert(1)")).toBeNull();
  });
});

describe("normalizeInn", () => {
  it("принимает 10 и 12 цифр", () => {
    expect(normalizeInn("7707 083893")).toBe("7707083893");
    expect(normalizeInn("123")).toBeNull();
  });
});

describe("parseCsv", () => {
  it("разбирает `;`, кавычки, экранированные кавычки и BOM", () => {
    const t = parseCsv('﻿название;город\r\n"СТО ""Север""; плюс";Казань\r\n');
    expect(t).toEqual([["название", "город"], ['СТО "Север"; плюс', "Казань"]]);
  });
  it("определяет запятую и многострочные ячейки", () => {
    const t = parseCsv('name,city\n"a\nb",Kazan');
    expect(t[1]).toEqual(["a\nb", "Kazan"]);
  });
  it("пропускает пустые строки", () => {
    expect(parseCsv("a;b\n\n;\n1;2")).toEqual([["a", "b"], ["1", "2"]]);
  });
});

describe("csv export", () => {
  it("нейтрализует CSV-инъекции", () => {
    expect(csvCell("=HYPERLINK(1)")).toBe("\"'=HYPERLINK(1)\"");
    expect(csvCell('a"b')).toBe('"a""b"');
    expect(toCsv([["x"]])).toBe('﻿"x"');
  });
});

describe("mapImportRows", () => {
  const existing = [{ name: "СТО «Север»", city: "Казань", domain: "sever.example", inn: "7707083893" }];
  it("сообщает об отсутствующих колонках", () => {
    expect(mapImportRows([["a", "b"], ["1", "2"]], []).missingColumns).toEqual(["название", "город"]);
  });
  it("ИНН и домен+город — точные дубли; одинаковое название — только кандидат", () => {
    const table = [["название", "город", "сайт", "инн"], ["Другое", "Москва", "", "7707083893"], ["Иное", "Казань", "www.sever.example", ""], ["СТО Север", "г. Казань", "", ""]];
    const { rows } = mapImportRows(table, existing);
    expect(rows[0]!.duplicate?.kind).toBe("exact");
    expect(rows[1]!.duplicate?.kind).toBe("exact");
    expect(rows[2]!.duplicate?.kind).toBe("candidate");
  });
  it("филиалы с одним доменом в разных городах не сливаются", () => {
    const { rows } = mapImportRows([["название", "город", "сайт"], ["Сеть", "Казань", "net.example"], ["Сеть", "Уфа", "net.example"]], []);
    expect(rows.every((r) => r.duplicate === null)).toBe(true);
  });
  it("дубли внутри файла и ошибки строк", () => {
    const { rows } = mapImportRows([["название", "город", "сайт", "инн"], ["А", "Уфа", "a.example", ""], ["А2", "Уфа", "a.example", ""], ["", "Уфа", "bad host", "12"]], []);
    expect(rows[1]!.duplicate?.kind).toBe("in_file");
    expect(rows[2]!.issues).toEqual(expect.arrayContaining(["Нет названия", "Некорректный сайт", "Некорректный ИНН"]));
  });
});
