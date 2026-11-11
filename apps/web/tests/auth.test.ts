import { describe, expect, it } from "vitest";
import { authErrorText, formatCountdown, isValidEmail, maskEmail, remainingSeconds, userInitials } from "@/lib/auth";
import { backspaceAt, cellsToCode, emptyCells, isComplete, sanitizeDigits, typeAt } from "@/lib/otp";

describe("маскирование email", () => {
  it("оставляет первую букву и домен", () => {
    expect(maskEmail("anna@mail.ru")).toBe("a***@mail.ru");
    expect(maskEmail("i@x.io")).toBe("i***@x.io");
    expect(maskEmail("first.last+tag@sub.example.com")).toBe("f***@sub.example.com");
  });
  it("не ломается на строке без @", () => { expect(maskEmail("nope")).toBe("nope"); });
});

describe("проверка email и инициалы", () => {
  it("принимает обычные адреса и отклоняет мусор", () => {
    expect(isValidEmail(" a@b.ru ")).toBe(true);
    for (const bad of ["", "a@b", "a b@c.ru", "@b.ru", "a@@b.ru"]) expect(isValidEmail(bad)).toBe(false);
  });
  it("инициалы из email", () => { expect(userInitials({ email: "owner@x.ru" })).toBe("OW"); });
  it("тексты ошибок по кодам", () => {
    expect(authErrorText("RATE_LIMITED", 30)).toContain("30 с");
    expect(authErrorText("MAIL_UNAVAILABLE")).toContain("письмо");
  });
});

describe("таймер повторной отправки", () => {
  it("форматирует m:ss", () => {
    expect(formatCountdown(42)).toBe("0:42");
    expect(formatCountdown(60)).toBe("1:00");
    expect(formatCountdown(5)).toBe("0:05");
    expect(formatCountdown(0)).toBe("0:00");
    expect(formatCountdown(-3)).toBe("0:00");
    expect(formatCountdown(41.2)).toBe("0:42");
  });
  it("считает остаток по дедлайну и не уходит в минус", () => {
    expect(remainingSeconds(10_000, 0)).toBe(10);
    expect(remainingSeconds(10_000, 9_001)).toBe(1);
    expect(remainingSeconds(10_000, 10_000)).toBe(0);
    expect(remainingSeconds(10_000, 20_000)).toBe(0);
  });
});

describe("CodeInput: ввод по ячейкам", () => {
  it("фильтрует нецифровые символы", () => {
    expect(sanitizeDigits("12a-3 4")).toBe("1234");
    const r = typeAt(emptyCells(), 0, "x");
    expect(r.cells.every((c) => c === "")).toBe(true);
    expect(r.focus).toBe(0);
  });
  it("цифра ставится в ячейку и сдвигает фокус вперёд", () => {
    const r = typeAt(emptyCells(), 2, "7");
    expect(r.cells[2]).toBe("7");
    expect(r.focus).toBe(3);
  });
  it("в последней ячейке фокус остаётся на ней", () => {
    expect(typeAt(emptyCells(), 5, "9").focus).toBe(5);
  });
  it("ввод поверх заполненной ячейки берёт новую цифру", () => {
    const c = emptyCells(); c[1] = "4";
    expect(typeAt(c, 1, "45").cells[1]).toBe("5");
    expect(typeAt(c, 1, "34").cells[1]).toBe("3");
    expect(typeAt(c, 1, "44").cells[1]).toBe("4");
  });
  it("вставка целого кода заполняет все ячейки независимо от позиции", () => {
    const r = typeAt(emptyCells(), 3, "123456");
    expect(r.cells).toEqual(["1", "2", "3", "4", "5", "6"]);
    expect(isComplete(r.cells)).toBe(true);
    expect(cellsToCode(r.cells)).toBe("123456");
  });
  it("вставка с пробелами и лишним текстом", () => {
    expect(typeAt(emptyCells(), 0, "Код: 123 456").cells.join("")).toBe("123456");
    expect(typeAt(emptyCells(), 0, "1234567890").cells.join("")).toBe("123456");
  });
  it("частичная вставка начинается с текущей ячейки", () => {
    const r = typeAt(emptyCells(), 2, "98");
    expect(r.cells).toEqual(["", "", "9", "8", "", ""]);
    expect(r.focus).toBe(4);
  });
  it("Backspace: очищает текущую, иначе предыдущую с переходом назад", () => {
    const c = ["1", "2", "3", "", "", ""];
    expect(backspaceAt(c, 2)).toEqual({ cells: ["1", "2", "", "", "", ""], focus: 2 });
    expect(backspaceAt(c, 3)).toEqual({ cells: ["1", "2", "", "", "", ""], focus: 2 });
    expect(backspaceAt(emptyCells(), 0)).toEqual({ cells: emptyCells(), focus: 0 });
  });
  it("isComplete требует все шесть цифр", () => {
    expect(isComplete(["1", "2", "3", "4", "5", ""])).toBe(false);
    expect(isComplete(emptyCells())).toBe(false);
  });
});
