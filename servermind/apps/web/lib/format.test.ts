import { describe, expect, it } from "vitest";
import { formatDateTimeUtc, formatTimeUtc, formatUptime, maskHost, plural, relativeTime } from "./format";

describe("format", () => {
  it("время только в UTC", () => {
    expect(formatTimeUtc("2026-11-09T14:25:07.000Z")).toBe("14:25 UTC");
    expect(formatDateTimeUtc("2026-11-09T04:05:00.000Z")).toBe("09.11 04:05 UTC");
  });
  it("нет данных вместо выдуманных значений", () => {
    expect(formatTimeUtc(null)).toBe("—");
    expect(formatTimeUtc("мусор")).toBe("—");
    expect(relativeTime(null)).toBe("нет данных");
    expect(formatUptime(null)).toBe("—");
  });
  it("склонение", () => {
    expect(plural(1, "сервер", "сервера", "серверов")).toBe("сервер");
    expect(plural(2, "сервер", "сервера", "серверов")).toBe("сервера");
    expect(plural(5, "сервер", "сервера", "серверов")).toBe("серверов");
    expect(plural(11, "сервер", "сервера", "серверов")).toBe("серверов");
    expect(plural(21, "сервер", "сервера", "серверов")).toBe("сервер");
  });
  it("относительное время", () => {
    const now = Date.parse("2026-11-09T12:00:00Z");
    expect(relativeTime("2026-11-09T11:57:00Z", now)).toBe("3 минуты назад");
    expect(relativeTime("2026-11-09T09:00:00Z", now)).toBe("3 часа назад");
  });
  it("маскировка адреса в отчёте", () => {
    expect(maskHost("203.0.113.10")).toBe("203.0.x.x");
    expect(maskHost("app.servermind.example")).toBe("•••.servermind.example");
  });
});
