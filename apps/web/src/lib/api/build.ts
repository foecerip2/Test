/** Сборка рабочего API (live). Не импортирует демо-код: в live-бандл он не попадает. */
import { createLiveAdmin } from "./live-admin";
import { createLiveAuth } from "./live-auth";
import { createLiveCompanies } from "./live-companies";
import { createLivePilots } from "./live-pilots";
import { createLiveSoon } from "./live-soon";
import type { Api } from "./types";

/** Живые данные: компании, импорт и сводка — с сервера; вход — настоящий; остальные разделы честно «скоро». */
export function buildLiveApi(): Api {
  const listeners = new Set<() => void>();
  const live = createLiveCompanies(undefined, undefined, () => listeners.forEach((l) => l()));
  return {
    ...createLiveSoon(),
    ...live,
    mode: "live",
    authMode: "live",
    auth: createLiveAuth(),
    admin: createLiveAdmin(),
    pilotRequests: createLivePilots(undefined, undefined, () => listeners.forEach((l) => l())),
    subscribe(cb) { listeners.add(cb); return () => { listeners.delete(cb); }; },
  };
}
