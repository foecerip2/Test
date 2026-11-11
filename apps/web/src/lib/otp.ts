import { OTP_LENGTH } from "./auth";

/** Только цифры (в т.ч. из вставки «123 456», «123-456»). */
export function sanitizeDigits(raw: string, max = OTP_LENGTH): string {
  return raw.replace(/\D/g, "").slice(0, max);
}

export const emptyCells = (n = OTP_LENGTH): string[] => Array.from({ length: n }, () => "");
export const isComplete = (cells: string[]): boolean => cells.length > 0 && cells.every((c) => c.length === 1);
export const cellsToCode = (cells: string[]): string => cells.join("");

export interface CellsUpdate { cells: string[]; focus: number }

/**
 * Ввод в ячейку i. raw — то, что оказалось в поле: одна цифра, две (ввод поверх заполненной),
 * либо много (вставка / автозаполнение одноразовым кодом).
 */
export function typeAt(cells: string[], i: number, raw: string): CellsUpdate {
  const n = cells.length;
  let digits = sanitizeDigits(raw, 64);
  const next = cells.slice();
  if (!digits) return { cells: next, focus: i };
  const existing = cells[i] ?? "";
  if (digits.length === 2 && existing) {
    // Ввод поверх заполненной ячейки: берём новую цифру, а не старую.
    const k = digits.indexOf(existing);
    digits = k >= 0 ? digits.slice(0, k) + digits.slice(k + 1) : digits.slice(-1);
  }
  if (digits.length === 1) {
    next[i] = digits;
    return { cells: next, focus: Math.min(i + 1, n - 1) };
  }
  // Вставка: полный код всегда заполняет все ячейки с начала, короткий — начиная с текущей.
  const start = digits.length >= n ? 0 : i;
  const part = digits.slice(0, n - start);
  for (let k = 0; k < part.length; k++) next[start + k] = part[k]!;
  return { cells: next, focus: Math.min(start + part.length, n - 1) };
}

/** Backspace: очищает текущую ячейку, а если она пуста — предыдущую с переходом назад. */
export function backspaceAt(cells: string[], i: number): CellsUpdate {
  const next = cells.slice();
  if (next[i]) { next[i] = ""; return { cells: next, focus: i }; }
  if (i > 0) { next[i - 1] = ""; return { cells: next, focus: i - 1 }; }
  return { cells: next, focus: 0 };
}
