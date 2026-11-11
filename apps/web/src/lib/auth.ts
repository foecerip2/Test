import type { AuthUser } from "./api/types";

export const OTP_LENGTH = 6;

/** Мягкая проверка формата: окончательное решение за сервером. */
export function isValidEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim());
}

/** anna@mail.ru → a***@mail.ru */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return email;
  return `${email.slice(0, 1)}***${email.slice(at)}`;
}

/** 42 → «0:42», 600 → «10:00». */
export function formatCountdown(totalSeconds: number): string {
  const t = Math.max(0, Math.ceil(totalSeconds));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

/** Сколько секунд осталось до момента deadline (мс). */
export function remainingSeconds(deadline: number, now: number): number {
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}

export function userInitials(u: Pick<AuthUser, "email">): string {
  return u.email.replace(/[^\p{L}\p{N}]/gu, "").slice(0, 2).toUpperCase() || "—";
}

export function userLabel(u: Pick<AuthUser, "role">): string {
  return u.role === "owner" ? "Владелец" : "Пользователь";
}

/** Русский текст ошибки по коду API (сообщения сервера в интерфейс не выводим). */
export function authErrorText(code: string, retryAfter?: number): string {
  switch (code) {
    case "INVALID_EMAIL": return "Проверьте адрес: он должен выглядеть как name@example.com.";
    case "RATE_LIMITED": return retryAfter ? `Слишком много запросов. Повторите через ${retryAfter < 90 ? `${retryAfter} с` : `${Math.ceil(retryAfter / 60)} мин`}.` : "Слишком много запросов. Повторите чуть позже.";
    case "MAIL_UNAVAILABLE": return "Не удалось отправить письмо. Попробуйте чуть позже.";
    case "NETWORK": return "Нет соединения с сервером. Проверьте интернет и повторите.";
    default: return "Что-то пошло не так. Повторите попытку.";
  }
}
