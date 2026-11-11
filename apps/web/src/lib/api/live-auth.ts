/** Реальный клиент входа по email и коду: /api/v1/auth/*, cookie-сессия, CSRF-заголовок для мутаций вне /auth/otp/*. */
import { ApiError, type Api, type AuthUser } from "./types";

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

export function createLiveAuth(fetchImpl?: FetchLike, csrf: () => string | null = () => readCookie(CSRF_COOKIE)): Api["auth"] {
  const doFetch: FetchLike = fetchImpl ?? ((i, init) => fetch(i, init));

  async function call(path: string, method: "GET" | "POST", body?: Json): Promise<{ status: number; data: Json | null }> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (body) headers["Content-Type"] = "application/json";
    if (method !== "GET" && !path.startsWith("/auth/otp/")) {
      const t = csrf();
      if (t) headers["X-CSRF-Token"] = t;
    }
    let res: Response;
    try {
      res = await doFetch(BASE + path, { method, headers, credentials: "same-origin", body: body ? JSON.stringify(body) : undefined });
    } catch {
      throw new ApiError(0, "NETWORK", "Нет соединения с сервером");
    }
    let data: Json | null = null;
    if (res.status !== 204) { try { data = (await res.json()) as Json; } catch { data = null; } }
    if (!res.ok) {
      const nested = (data?.details ?? null) as Json | null;
      const left = data?.attempts_left ?? nested?.attempts_left;
      const ra = Number(res.headers.get("Retry-After"));
      throw new ApiError(
        res.status,
        typeof data?.code === "string" ? data.code : "UNKNOWN",
        typeof data?.message === "string" ? data.message : "Ошибка запроса",
        {
          attemptsLeft: typeof left === "number" ? left : undefined,
          retryAfter: Number.isFinite(ra) && ra > 0 ? ra : undefined,
          requestId: typeof data?.request_id === "string" ? data.request_id : undefined,
        },
      );
    }
    return { status: res.status, data };
  }

  return {
    async requestCode(email) {
      const { data } = await call("/auth/otp/request", "POST", { email: email.trim() });
      return { challengeId: String(data?.challenge_id ?? ""), expiresIn: Number(data?.expires_in ?? 600), resendIn: Number(data?.resend_in ?? 60) };
    },
    async verifyCode(challengeId, code) {
      const { data } = await call("/auth/otp/verify", "POST", { challenge_id: challengeId, code });
      return { user: data?.user as AuthUser, isNew: Boolean(data?.is_new) };
    },
    async resendCode(challengeId) {
      const { data } = await call("/auth/otp/resend", "POST", { challenge_id: challengeId });
      return { resendIn: Number(data?.resend_in ?? 60) };
    },
    async me() {
      try {
        const { data } = await call("/auth/me", "GET");
        return (data?.user as AuthUser | undefined) ?? null;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    async logout() {
      await call("/auth/logout", "POST");
    },
  };
}
