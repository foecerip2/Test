/** Демонстрационный API (разработка и автотесты): mock-данные, вход по коду; при AUTH_MODE=live вход настоящий. */
import { createLiveAdmin } from "./live-admin";
import { createLiveAuth } from "./live-auth";
import { createMockApi, type MockOptions } from "./mock";
import type { Api } from "./types";

export function createDemoApi(authLive: boolean, opts: MockOptions = {}): Api {
  const mock = createMockApi(opts);
  return authLive ? { ...mock, authMode: "live", auth: createLiveAuth(), admin: createLiveAdmin() } : mock;
}
