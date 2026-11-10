/**
 * DEV-ФИКСТУРЫ. Синтетические данные для разработки дизайна. Не отражают реальные серверы.
 * Подключаются только при NEXT_PUBLIC_DEV_FIXTURES=1 (см. lib/api/index.ts); интерфейс при этом
 * всегда показывает ribbon «Демо-данные». IP — из диапазона документации 203.0.113.0/24 (RFC 5737).
 */
import type { DeployTemplate, MetricSample, ServerSummary, ServiceInfo } from "@/lib/types";

export const NOW = () => Date.now();
export const iso = (offsetSec: number) => new Date(Date.now() + offsetSec * 1000).toISOString();

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Детерминированный ряд (шаг 15 минут). Только для демонстрации графиков. */
export function demoSeries(seed: number, points: number, base: { cpu: number; ram: number; disk: number }): MetricSample[] {
  const rnd = mulberry32(seed);
  const stepMs = 15 * 60 * 1000;
  const end = Math.floor(Date.now() / stepMs) * stepMs;
  const out: MetricSample[] = [];
  let cpu = base.cpu;
  for (let i = points - 1; i >= 0; i--) {
    const t = end - i * stepMs;
    cpu = Math.max(2, Math.min(96, cpu + (rnd() - 0.5) * 14 + (base.cpu - cpu) * 0.15));
    const ram = Math.max(10, Math.min(95, base.ram + Math.sin((points - i) / 9) * 4 + (rnd() - 0.5) * 2));
    const disk = Math.max(5, Math.min(99, base.disk - i * 0.01 + (rnd() - 0.5) * 0.1));
    out.push({ t: new Date(t).toISOString(), cpu: +cpu.toFixed(1), ram: +ram.toFixed(1), disk: +disk.toFixed(1) });
  }
  return out;
}

const svc = (name: string, state: ServiceInfo["state"], managed = false): ServiceInfo => ({ name, state, managed });

export function seedServers(): ServerSummary[] {
  return [
    {
      id: "srv_demo_web1", name: "demo-web-1", host: "203.0.113.10", port: 22, username: "servermind",
      os: "Ubuntu 24.04.1 LTS", status: "online", lastCheckedAt: iso(-42), lastSuccessAt: iso(-42),
      uptimeSeconds: 18 * 86400 + 5 * 3600, cpuPercent: 24, ramUsedMb: 1638, ramTotalMb: 4096,
      diskUsedGb: 12.8, diskTotalGb: 40,
      fingerprint: "SHA256:Qz8mR9xKpL2vTn4WcYb7HdJeA1sUf3oZiGq6NrXkP2w",
      services: [svc("nginx", "active"), svc("docker", "active"), svc("myapp", "failed", true), svc("postgresql", "active"), svc("ssh", "active")],
      source: "demo",
    },
    {
      id: "srv_demo_stage", name: "demo-staging", host: "staging.servermind.example", port: 22, username: "servermind",
      os: "Ubuntu 24.04.1 LTS", status: "online", lastCheckedAt: iso(-95), lastSuccessAt: iso(-95),
      uptimeSeconds: 3 * 86400 + 7 * 3600, cpuPercent: 8, ramUsedMb: 912, ramTotalMb: 4096,
      diskUsedGb: 6.1, diskTotalGb: 40,
      fingerprint: "SHA256:b1Ke7WqPz0XcM4yTnHs9RdLfA6uVg2oJiEq3NrZkY5c",
      services: [svc("nginx", "active"), svc("docker", "inactive"), svc("ssh", "active")],
      source: "demo",
    },
    {
      id: "srv_demo_archive", name: "demo-archive", host: "203.0.113.77", port: 2222, username: "servermind",
      os: "Ubuntu 22.04.5 LTS", status: "offline", lastCheckedAt: iso(-60), lastSuccessAt: iso(-3 * 3600 - 1260),
      uptimeSeconds: null, cpuPercent: null, ramUsedMb: null, ramTotalMb: null,
      diskUsedGb: 36.8, diskTotalGb: 40,
      fingerprint: "SHA256:Hd3Ye9TpW1KcM7xQnLs4RbVfA2uZg8oJiEq6NrXkP0a",
      services: [],
      source: "demo",
    },
  ];
}

export const DEMO_HISTORY_BASE: Record<string, { seed: number; cpu: number; ram: number; disk: number }> = {
  srv_demo_web1: { seed: 11, cpu: 26, ram: 40, disk: 32 },
  srv_demo_stage: { seed: 23, cpu: 9, ram: 22, disk: 15 },
};

export const TEMPLATES: DeployTemplate[] = [
  {
    id: "web-app", name: "Web-приложение (контейнер)", port: 8080, available: true,
    description: "Готовый образ из реестра без привилегий: непривилегированный пользователь, read-only root FS, без host-mount. Порт 8080 за Caddy.",
  },
  { id: "static-site", name: "Статический сайт", port: 8080, available: false, description: "Скоро: раздача статики через Caddy." },
  { id: "postgres", name: "PostgreSQL (управляемая БД)", port: 5432, available: false, description: "Скоро. Базы данных ставятся только вручную, пока не пройден security review." },
];

export const DEMO_PUBLIC_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAADEVMOCK0DEMO0KEY0NOT0FOR0USE00000000 servermind-DEMO-key";

export const DEMO_LOG_LINES: Record<string, string[]> = {
  myapp: [
    "2026-11-09T14:02:11Z myapp[2210]: listening on :8080",
    "2026-11-09T14:19:40Z myapp[2210]: error: connect ECONNREFUSED 127.0.0.1:5432",
    "2026-11-09T14:19:41Z myapp[2210]: fatal: database pool exhausted, exiting",
    "2026-11-09T14:19:41Z systemd[1]: myapp.service: Main process exited, code=exited, status=1/FAILURE",
    "2026-11-09T14:19:41Z systemd[1]: myapp.service: Failed with result 'exit-code'.",
  ],
  nginx: [
    "203.0.113.55 - - [09/Nov/2026:14:20:03 +0000] \"GET / HTTP/1.1\" 502 157",
    "2026/11/09 14:20:03 [error] 811#811: *412 connect() failed (111: Connection refused) while connecting to upstream",
  ],
  default: ["(демо) записей нет"],
};
