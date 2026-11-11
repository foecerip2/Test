/** Реальный клиент администрирования пользователей (только owner): /api/v1/admin/users*, cookie-сессия, CSRF. */
import { ApiError, type AdminUser, type Api, type UserRole, type UserStatus } from "./types";

const BASE = "/api/v1";
const CSRF_COOKIE = "lh_csrf";

function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  for (const part of document.cookie.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

type Json = Record<string, unknown>;
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Ответ сервера (snake_case) → AdminUser. */
export function toAdminUser(raw: unknown): AdminUser {
  const r = (raw ?? {}) as Json;
  return {
    id: String(r.id ?? ""),
    email: String(r.email ?? ""),
    role: (r.role === "owner" ? "owner" : "user") as UserRole,
    status: (r.status === "active" || r.status === "blocked" ? r.status : "pending") as UserStatus,
    createdAt: String(r.created_at ?? ""),
    lastLoginAt: typeof r.last_login_at === "string" ? r.last_login_at : null,
  };
}

export function createLiveAdmin(fetchImpl?: FetchLike, csrf: () => string | null = () => readCookie(CSRF_COOKIE)): Api["admin"] {
  const doFetch: FetchLike = fetchImpl ?? ((i, init) => fetch(i, init));

  async function call(path: string, method: "GET" | "POST"): Promise<Json | null> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (method !== "GET") {
      const t = csrf();
      if (t) headers["X-CSRF-Token"] = t;
    }
    let res: Response;
    try {
      res = await doFetch(BASE + path, { method, headers, credentials: "same-origin" });
    } catch {
      throw new ApiError(0, "NETWORK", "Нет соединения с сервером");
    }
    let data: Json | null = null;
    try { data = (await res.json()) as Json; } catch { data = null; }
    if (!res.ok) {
      throw new ApiError(
        res.status,
        typeof data?.code === "string" ? data.code : "UNKNOWN",
        typeof data?.message === "string" ? data.message : "Ошибка запроса",
        { requestId: typeof data?.request_id === "string" ? data.request_id : undefined },
      );
    }
    return data;
  }

  const enc = encodeURIComponent;
  return {
    async listUsers() {
      const data = await call("/admin/users", "GET");
      const list = Array.isArray(data?.users) ? (data.users as unknown[]) : [];
      return list.map(toAdminUser);
    },
    async approveUser(userId) {
      return toAdminUser((await call(`/admin/users/${enc(userId)}/approve`, "POST"))?.user);
    },
    async blockUser(userId) {
      return toAdminUser((await call(`/admin/users/${enc(userId)}/block`, "POST"))?.user);
    },
  };
}
