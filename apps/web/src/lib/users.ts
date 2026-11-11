import { ApiError, type AdminUser, type Tone, type UserRole, type UserStatus } from "./api/types";

export const USER_STATUS_LABEL: Record<UserStatus, string> = { pending: "Ожидает одобрения", active: "Активен", blocked: "Заблокирован" };
export const USER_STATUS_TONE: Record<UserStatus, Tone> = { pending: "amber", active: "green", blocked: "red" };
export const USER_ROLE_LABEL: Record<UserRole, string> = { owner: "Владелец", user: "Пользователь" };

export type UserFilter = "all" | UserStatus;

const ORDER: Record<UserStatus, number> = { pending: 0, active: 1, blocked: 2 };

/** Сначала ожидающие, затем активные, затем заблокированные; внутри группы — новые регистрации выше. */
export function sortUsers(users: AdminUser[]): AdminUser[] {
  return [...users].sort((a, b) => ORDER[a.status] - ORDER[b.status] || Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.email.localeCompare(b.email));
}

export function countByStatus(users: AdminUser[]): Record<UserStatus, number> {
  const c: Record<UserStatus, number> = { pending: 0, active: 0, blocked: 0 };
  for (const u of users) c[u.status] += 1;
  return c;
}

export function pendingCount(users: AdminUser[] | null | undefined): number {
  return users ? users.filter((u) => u.status === "pending").length : 0;
}

/** «N пользователей ждут одобрения» с правильным склонением. */
export function pendingText(n: number): string {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return `${n} пользователь ждёт одобрения`;
  return `${n} ${m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? "пользователя ждут" : "пользователей ждут"} одобрения`;
}

/** Причина, по которой «Заблокировать» недоступна; null — можно. Решает сервер, это только подсказка. */
export function blockDisabledReason(target: AdminUser, meId: string | null, all: AdminUser[]): string | null {
  if (target.id === meId) return "Нельзя заблокировать себя";
  if (target.role === "owner" && target.status === "active" && all.filter((u) => u.role === "owner" && u.status === "active").length <= 1) {
    return "Нельзя заблокировать последнего владельца";
  }
  return null;
}

/** Русский текст ошибки админ-API по коду (сообщения сервера в интерфейс не выводим). */
export function adminErrorText(e: unknown): string {
  if (!(e instanceof ApiError)) return "Не удалось выполнить действие. Попробуйте ещё раз.";
  switch (e.code) {
    case "CANNOT_BLOCK_SELF": return "Нельзя заблокировать самого себя.";
    case "LAST_OWNER": return "Нельзя заблокировать последнего владельца: без него некому будет одобрять пользователей.";
    case "FORBIDDEN": return "Управлять пользователями может только владелец.";
    case "UNAUTHENTICATED": return "Сессия истекла. Войдите заново.";
    case "NOT_FOUND": return "Пользователь не найден. Обновите список.";
    case "CSRF_FAILED":
    case "ORIGIN_FORBIDDEN": return "Запрос отклонён защитой. Обновите страницу и повторите.";
    case "NETWORK": return "Нет соединения с сервером. Проверьте интернет и повторите.";
    default: return "Не удалось выполнить действие. Попробуйте ещё раз.";
  }
}
