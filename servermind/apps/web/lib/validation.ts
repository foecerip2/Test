/** UX-проверки на клиенте. Источник истины — сервер (Фаза 2: SSRF-политика, DNS re-resolve + pinning). */

const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export type HostCheck = { ok: true } | { ok: false; reason: string };

export function checkHost(raw: string): HostCheck {
  const host = raw.trim().toLowerCase();
  if (!host) return { ok: false, reason: "Укажите IP-адрес или доменное имя." };
  const v4 = IPV4_RE.exec(host);
  if (v4) {
    const o = v4.slice(1).map(Number) as [number, number, number, number];
    if (o.some((n) => n > 255)) return { ok: false, reason: "Некорректный IPv4-адрес." };
    const [a, b] = o;
    if (
      a === 10 || a === 127 || a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    ) {
      return { ok: false, reason: "Приватные, loopback и link-local адреса запрещены политикой безопасности." };
    }
    return { ok: true };
  }
  if (host.includes(":")) return { ok: false, reason: "IPv6 в MVP не поддерживается. Используйте IPv4 или доменное имя." };
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) {
    return { ok: false, reason: "Локальные имена запрещены политикой безопасности." };
  }
  if (!HOSTNAME_RE.test(host)) return { ok: false, reason: "Некорректное доменное имя." };
  return { ok: true };
}

export function checkPort(raw: string): { ok: true; port: number } | { ok: false; reason: string } {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return { ok: false, reason: "Порт — число от 1 до 65535." };
  return { ok: true, port: n };
}

export function checkUsername(raw: string): { ok: true } | { ok: false; reason: string } {
  const u = raw.trim();
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(u)) return { ok: false, reason: "Имя пользователя: строчные латинские буквы, цифры, _ и -." };
  return { ok: true };
}

export function checkEmail(raw: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(raw.trim());
}

export function checkDomain(raw: string): boolean {
  return HOSTNAME_RE.test(raw.trim());
}

export function maskKey(key: string): string {
  const t = key.trim();
  return t.length <= 8 ? "••••" : `${t.slice(0, 3)}••••${t.slice(-4)}`;
}
