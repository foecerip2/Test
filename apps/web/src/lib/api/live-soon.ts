/**
 * Разделы, которых ещё нет на сервере (черновики, исходящие, согласия, диалоги, задачи, кампании, очередь, источники,
 * подавление, аудит, настройки). В live-режиме это НЕ mock: любой вызов честно отвечает «ещё не подключено».
 * Страницы этих разделов не обращаются к API, а показывают состояние «Раздел появится в следующем обновлении».
 */
import { ApiError, type Api } from "./types";

export const SOON_TITLE = "Раздел появится в следующем обновлении";
export const SOON_TEXT = "Эта часть ещё не подключена к серверу, поэтому здесь нет данных. Мы ничего не подставляем для красоты.";

const soon = (): Promise<never> => Promise.reject(new ApiError(501, "NOT_AVAILABLE", SOON_TITLE));

export type SoonApi = Pick<Api, "campaigns" | "jobs" | "sources" | "drafts" | "outbox" | "consents" | "conversations" | "tasks" | "suppression" | "audit" | "settings">;

export function createLiveSoon(): SoonApi {
  return {
    campaigns: { list: soon, create: soon, setStatus: soon },
    jobs: { list: soon, cancel: soon },
    sources: soon,
    drafts: { list: soon, get: soon, generate: soon, update: soon, approve: soon, reject: soon },
    outbox: { preview: soon, send: soon },
    consents: { record: soon, withdraw: soon },
    conversations: { list: soon, messages: soon, classify: soon, markRead: soon },
    tasks: { list: soon, create: soon, setStatus: soon },
    suppression: soon,
    audit: soon,
    settings: { get: soon, patch: soon },
  };
}
