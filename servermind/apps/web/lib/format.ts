const pad = (n: number) => String(n).padStart(2, "0");

/** «14:25 UTC» */
export function formatTimeUtc(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

/** «09.11 14:25 UTC» */
export function formatDateTimeUtc(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

export function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}

/** «2 мин назад». Если данных нет — «нет данных». */
export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "нет данных";
  const diff = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (diff < 45) return "только что";
  const min = Math.round(diff / 60);
  if (min < 60) return `${min} ${plural(min, "минуту", "минуты", "минут")} назад`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} ${plural(h, "час", "часа", "часов")} назад`;
  const d = Math.round(h / 24);
  return `${d} ${plural(d, "день", "дня", "дней")} назад`;
}

export function formatUptime(seconds: number | null): string {
  if (seconds == null) return "—";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  if (d > 0) return `${d} д ${h} ч`;
  const m = Math.floor((seconds % 3600) / 60);
  return `${h} ч ${m} мин`;
}

export function formatPercent(v: number | null | undefined): string {
  return v == null ? "—" : `${Math.round(v)}%`;
}

export function mbToGb(mb: number | null): string {
  if (mb == null) return "—";
  return `${(mb / 1024).toFixed(1).replace(".", ",")} ГБ`;
}

export function gb(v: number | null): string {
  if (v == null) return "—";
  return `${v.toFixed(1).replace(".", ",")} ГБ`;
}

export function formatNumber(n: number): string {
  return new Intl.NumberFormat("ru-RU").format(n);
}

/** Маскировка IP для диагностического отчёта: 203.0.113.10 → 203.0.x.x */
export function maskHost(host: string): string {
  const parts = host.split(".");
  if (parts.length === 4 && parts.every((p) => /^\d+$/.test(p))) return `${parts[0]}.${parts[1]}.x.x`;
  const dot = host.indexOf(".");
  return dot > 0 ? `•••${host.slice(dot)}` : "•••";
}
