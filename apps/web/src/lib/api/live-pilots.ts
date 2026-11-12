/** Заявки AutoFlow: данные только с сервера, доступ проверяет API по роли владельца. */
import { ApiError, type Api, type PilotRequest, type PilotStatus } from "./types";
import { errorText } from "./live-companies";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type Json = Record<string, unknown>;
const BASE = "/api/v1/autoflow/pilot-requests";

function csrfCookie(): string | null {
  if (typeof document === "undefined") return null;
  const part = document.cookie.split(";").map((p) => p.trim()).find((p) => p.startsWith("lh_csrf="));
  return part ? decodeURIComponent(part.slice("lh_csrf=".length)) : null;
}

function toPilot(raw: Json): PilotRequest {
  const strings = ["id", "business_name", "city", "contact_name", "note", "consent_text_version"];
  const dates = ["consent_at", "created_at", "updated_at"];
  if (!raw || strings.some((key) => typeof raw[key] !== "string") ||
      dates.some((key) => typeof raw[key] !== "string" || !Number.isFinite(Date.parse(raw[key] as string))) ||
      !["new", "contacted", "accepted", "declined", "spam"].includes(raw.status as string) ||
      ["phone", "email"].some((key) => raw[key] !== null && typeof raw[key] !== "string")) {
    throw new ApiError(502, "INVALID_RESPONSE", "Не удалось прочитать заявку. Обновите список.");
  }
  return {
    id: String(raw.id), businessName: String(raw.business_name), city: String(raw.city),
    contactName: String(raw.contact_name), phone: typeof raw.phone === "string" ? raw.phone : null,
    email: typeof raw.email === "string" ? raw.email : null, status: raw.status as PilotStatus,
    note: String(raw.note ?? ""), consentAt: String(raw.consent_at), consentTextVersion: String(raw.consent_text_version),
    createdAt: String(raw.created_at), updatedAt: String(raw.updated_at),
  };
}

export function createLivePilots(fetchImpl?: FetchLike, csrf: () => string | null = csrfCookie, notify: () => void = () => undefined): Api["pilotRequests"] {
  const doFetch: FetchLike = fetchImpl ?? ((i, init) => fetch(i, init));
  async function call(path: string, patch?: { status?: PilotStatus; note?: string }): Promise<Json> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (patch) {
      headers["Content-Type"] = "application/json";
      const token = csrf();
      if (token) headers["X-CSRF-Token"] = token;
    }
    let res: Response;
    try {
      res = await doFetch(BASE + path, { method: patch ? "PATCH" : "GET", headers, credentials: "same-origin", body: patch ? JSON.stringify(patch) : undefined, cache: "no-store" });
    } catch {
      throw new ApiError(0, "NETWORK", "Нет соединения с сервером.");
    }
    let data: Json | null = null;
    try { data = await res.json() as Json; } catch { /* У прокси может быть не JSON. */ }
    if (!res.ok) {
      const code = typeof data?.code === "string" ? data.code : "UNKNOWN";
      const text = code === "NOT_FOUND" ? "Заявка не найдена. Обновите список." : errorText(code, res.status);
      throw new ApiError(res.status, code, text);
    }
    if (!data) throw new ApiError(502, "INVALID_RESPONSE", "Сервер вернул некорректный ответ. Повторите запрос.");
    return data;
  }
  return {
    async list(filter) {
      const params = new URLSearchParams({ limit: String(Math.min(100, Math.max(1, filter.limit ?? 25))) });
      if (filter.status) params.set("status", filter.status);
      if (filter.cursor) params.set("cursor", filter.cursor);
      const data = await call(`?${params}`);
      if (!Array.isArray(data.items)) throw new ApiError(502, "INVALID_RESPONSE", "Не удалось прочитать список заявок.");
      return { items: data.items.map((r) => toPilot(r as Json)), nextCursor: typeof data.next_cursor === "string" ? data.next_cursor : null };
    },
    async update(id, patch) {
      const updated = toPilot(await call(`/${encodeURIComponent(id)}`, patch));
      notify();
      return updated;
    },
  };
}
