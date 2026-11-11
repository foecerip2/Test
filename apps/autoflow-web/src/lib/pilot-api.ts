import { siteConfig } from "@/lib/config";
import type { PilotPayload } from "@/lib/validate";

/**
 * unavailable — сервер ещё не принимает заявки (404/501/502/503/504): показываем контакт для связи напрямую;
 * invalid — сервер отклонил данные (400/422); rate — слишком часто (429); network — нет связи; server — иная ошибка.
 */
export type SubmitResult = { ok: true } | { ok: false; kind: "unavailable" | "invalid" | "rate" | "network" | "server" };

export function classifyStatus(status: number): SubmitResult {
  if (status >= 200 && status < 300) return { ok: true };
  if ([404, 405, 501, 502, 503, 504].includes(status)) return { ok: false, kind: "unavailable" };
  if (status === 400 || status === 422) return { ok: false, kind: "invalid" };
  if (status === 429) return { ok: false, kind: "rate" };
  return { ok: false, kind: "server" };
}

export async function submitPilot(
  payload: PilotPayload,
  opts: { mode?: "live" | "mock"; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<SubmitResult> {
  const mode = opts.mode ?? siteConfig.apiMode;
  if (mode === "mock") {
    await new Promise((r) => setTimeout(r, 500));
    return { ok: true };
  }
  const doFetch = opts.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 15000);
  try {
    const res = await doFetch(siteConfig.pilotEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
      credentials: "same-origin",
    });
    return classifyStatus(res.status);
  } catch {
    return { ok: false, kind: "network" };
  } finally {
    clearTimeout(timer);
  }
}
