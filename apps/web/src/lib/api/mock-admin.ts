/**
 * Mock администрирования пользователей (демо). Повторяет правила apps/api/app/routers/admin.py:
 * только owner (иначе 403 FORBIDDEN), approve → active, block → blocked,
 * нельзя заблокировать себя (400 CANNOT_BLOCK_SELF) и последнего активного владельца (409 LAST_OWNER).
 * Состояние в памяти; текущий пользователь берётся из mock-входа и всегда есть в списке.
 */
import { ApiError, type AdminUser, type Api } from "./types";

export interface MockAdminOptions {
  auth: Api["auth"];
  latency?: number;
  /** Блокировка любого владельца отвечает LAST_OWNER (имитация гонки на сервере). */
  lastOwner?: boolean;
  /** Чтение списка падает с 503 (?mock=error). */
  fail?: boolean;
  /** Сообщить подписчикам API об изменении (обновить счётчики в колокольчике и обзоре). */
  notify?: () => void;
}

const DAY = 86_400_000;
const ago = (days: number, hours = 0) => new Date(Date.now() - days * DAY - hours * 3_600_000).toISOString();

function seed(lastOwner: boolean): AdminUser[] {
  const list: AdminUser[] = [
    { id: "usr_anna", email: "anna.petrova@example.com", role: "user", status: "active", createdAt: ago(21), lastLoginAt: ago(0, 3) },
    { id: "usr_dmitry", email: "dmitry.volkov@example.org", role: "user", status: "active", createdAt: ago(9), lastLoginAt: ago(2) },
    { id: "usr_maria", email: "maria.sokolova@example.com", role: "user", status: "pending", createdAt: ago(0, 2), lastLoginAt: null },
    { id: "usr_ivan", email: "ivan@startup.example", role: "user", status: "pending", createdAt: ago(1), lastLoginAt: null },
    { id: "usr_long", email: "very.long.email.address.for.layout.check@department.subdomain.example.com", role: "user", status: "pending", createdAt: ago(3), lastLoginAt: null },
    { id: "usr_spam", email: "spam.test@example.net", role: "user", status: "blocked", createdAt: ago(14), lastLoginAt: ago(13) },
  ];
  if (lastOwner) list.push({ id: "usr_coowner", email: "co-owner@example.com", role: "owner", status: "active", createdAt: ago(40), lastLoginAt: ago(5) });
  return list;
}

export function createMockAdmin(opts: MockAdminOptions): Api["admin"] {
  const latency = opts.latency ?? 120;
  const wait = () => new Promise<void>((r) => setTimeout(r, latency));
  let users: AdminUser[] | null = null;

  async function owner(): Promise<{ id: string; users: AdminUser[] }> {
    const me = await opts.auth.me();
    if (!me) throw new ApiError(401, "UNAUTHENTICATED", "Требуется вход");
    if (me.role !== "owner" || me.status !== "active") throw new ApiError(403, "FORBIDDEN", "Недостаточно прав");
    if (!users) users = seed(Boolean(opts.lastOwner));
    if (!users.some((u) => u.id === me.id)) {
      users.unshift({ id: me.id, email: me.email, role: "owner", status: "active", createdAt: ago(60), lastLoginAt: new Date().toISOString() });
    }
    return { id: me.id, users };
  }
  const copy = (u: AdminUser): AdminUser => ({ ...u });

  return {
    async listUsers() {
      await wait();
      if (opts.fail) throw new ApiError(503, "UNAVAILABLE", "Сервис временно недоступен (демо-режим ошибки)");
      const { users: all } = await owner();
      return all.map(copy);
    },
    async approveUser(id) {
      await wait();
      const { users: all } = await owner();
      const u = all.find((x) => x.id === id);
      if (!u) throw new ApiError(404, "NOT_FOUND", "Пользователь не найден");
      u.status = "active";
      opts.notify?.();
      return copy(u);
    },
    async blockUser(id) {
      await wait();
      const { id: meId, users: all } = await owner();
      const u = all.find((x) => x.id === id);
      if (!u) throw new ApiError(404, "NOT_FOUND", "Пользователь не найден");
      if (u.id === meId) throw new ApiError(400, "CANNOT_BLOCK_SELF", "Нельзя заблокировать самого себя");
      if (u.role === "owner" && u.status === "active") {
        const owners = all.filter((x) => x.role === "owner" && x.status === "active").length;
        if (owners <= 1 || opts.lastOwner) throw new ApiError(409, "LAST_OWNER", "Нельзя заблокировать последнего владельца");
      }
      u.status = "blocked";
      opts.notify?.();
      return copy(u);
    },
  };
}
