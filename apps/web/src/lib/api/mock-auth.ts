/**
 * Mock-вход по email и коду (демо). Повторяет контракт /api/v1/auth/otp/* :
 * любой валидный email, код всегда 123456, TTL, лимит попыток, cooldown повторной отправки.
 * Email, начинающийся с «pending», получает статус pending; «blocked» — blocked; остальные active.
 */
import { isValidEmail } from "../auth";
import { ApiError, type Api, type AuthUser } from "./types";

export const DEMO_CODE = "123456";
export const MAX_ATTEMPTS = 5;

export interface MockAuthOptions {
  /** Повторная отправка через 3 с вместо 60 (?mock=fastresend). */
  fastResend?: boolean;
  /** Код живёт 6 с вместо 600 (?mock=fastexpire). */
  fastExpire?: boolean;
  /** Отправка письма недоступна (?mock=mailerror). */
  mailError?: boolean;
  /** Часы (для тестов). */
  now?: () => number;
  /** Задержка «сети», мс. */
  latency?: number;
  /** Хранилище сессии; по умолчанию sessionStorage. */
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
}

interface Challenge { email: string; expiresAt: number; attempts: number; resendAt: number }

const SESSION_KEY = "lh_demo_user";
const KNOWN_KEY = "lh_demo_known";

export function createMockAuth(opts: MockAuthOptions = {}): Api["auth"] {
  const now = opts.now ?? (() => Date.now());
  const latency = opts.latency ?? 120;
  const ttl = opts.fastExpire ? 6 : 600;
  const cooldown = opts.fastResend ? 3 : 60;
  const challenges = new Map<string, Challenge>();
  const memory = new Map<string, string>();
  let seq = 0;

  const store = (): NonNullable<MockAuthOptions["storage"]> => {
    if (opts.storage !== undefined && opts.storage !== null) return opts.storage;
    try { if (opts.storage !== null && globalThis.sessionStorage) return globalThis.sessionStorage; } catch { /* недоступно */ }
    return { getItem: (k) => memory.get(k) ?? null, setItem: (k, v) => { memory.set(k, v); }, removeItem: (k) => { memory.delete(k); } };
  };
  const wait = () => new Promise<void>((r) => setTimeout(r, latency));
  const known = (): string[] => { try { return JSON.parse(store().getItem(KNOWN_KEY) ?? "[]") as string[]; } catch { return []; } };

  function userFor(email: string): AuthUser {
    const local = email.toLowerCase();
    return {
      id: `u_${local.replace(/[^a-z0-9]/g, "").slice(0, 12) || "demo"}`,
      email,
      role: local.startsWith("owner") ? "owner" : "user",
      status: local.startsWith("pending") ? "pending" : local.startsWith("blocked") ? "blocked" : "active",
    };
  }

  return {
    async requestCode(emailRaw) {
      await wait();
      const email = emailRaw.trim();
      if (!isValidEmail(email)) throw new ApiError(400, "INVALID_EMAIL", "Некорректный email");
      if (opts.mailError) throw new ApiError(503, "MAIL_UNAVAILABLE", "Почтовый сервис недоступен");
      const id = `ch_${++seq}_${Math.floor(now() / 1000)}`;
      challenges.set(id, { email, expiresAt: now() + ttl * 1000, attempts: 0, resendAt: now() + cooldown * 1000 });
      return { challengeId: id, expiresIn: ttl, resendIn: cooldown };
    },

    async verifyCode(challengeId, code) {
      await wait();
      const ch = challenges.get(challengeId);
      if (!ch || now() >= ch.expiresAt) { challenges.delete(challengeId); throw new ApiError(410, "CODE_EXPIRED", "Срок действия кода истёк"); }
      if (ch.attempts >= MAX_ATTEMPTS) throw new ApiError(429, "TOO_MANY_ATTEMPTS", "Слишком много попыток");
      if (code !== DEMO_CODE) {
        ch.attempts += 1;
        const left = MAX_ATTEMPTS - ch.attempts;
        if (left <= 0) throw new ApiError(429, "TOO_MANY_ATTEMPTS", "Слишком много попыток", { attemptsLeft: 0 });
        throw new ApiError(400, "INVALID_CODE", "Неверный код", { attemptsLeft: left });
      }
      challenges.delete(challengeId);
      const user = userFor(ch.email);
      const list = known();
      const isNew = !list.includes(user.email.toLowerCase());
      if (isNew) store().setItem(KNOWN_KEY, JSON.stringify([...list, user.email.toLowerCase()]));
      store().setItem(SESSION_KEY, JSON.stringify(user));
      return { user, isNew };
    },

    async resendCode(challengeId) {
      await wait();
      const ch = challenges.get(challengeId);
      if (!ch) throw new ApiError(410, "CODE_EXPIRED", "Срок действия кода истёк");
      const left = Math.ceil((ch.resendAt - now()) / 1000);
      if (left > 0) throw new ApiError(429, "RATE_LIMITED", "Слишком частые запросы", { retryAfter: left });
      if (opts.mailError) throw new ApiError(503, "MAIL_UNAVAILABLE", "Почтовый сервис недоступен");
      // Новый код: попытки и срок действия обновляются.
      ch.attempts = 0; ch.expiresAt = now() + ttl * 1000; ch.resendAt = now() + cooldown * 1000;
      return { resendIn: cooldown };
    },

    async me() {
      await wait();
      try { const raw = store().getItem(SESSION_KEY); return raw ? (JSON.parse(raw) as AuthUser) : null; } catch { return null; }
    },

    async logout() {
      await wait();
      store().removeItem(SESSION_KEY);
    },
  };
}
