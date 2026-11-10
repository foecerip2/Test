import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV !== "production";
const apiBase = process.env.API_BASE_URL;

// CSP: Next.js требует inline-скрипты для гидрации (без nonce-инфраструктуры).
// 'unsafe-eval' разрешён только в dev (React refresh).
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  `connect-src 'self'${isDev ? " ws: wss:" : ""}`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const nextConfig: NextConfig = {
  output: "standalone",
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // Всегда задаём значение: тогда Next подставляет литерал на этапе сборки, и dev-фикстуры вырезаются из production-бандла.
  env: { NEXT_PUBLIC_DEV_FIXTURES: process.env.NEXT_PUBLIC_DEV_FIXTURES === "1" ? "1" : "0" },
  poweredByHeader: false,
  reactStrictMode: true,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
  // Проксирование API (Фаза 2). Пока API не развёрнут, запросы завершаются ошибкой,
  // и UI честно показывает состояние «бэкенд недоступен».
  async rewrites() {
    return apiBase ? [{ source: "/api/v1/:path*", destination: `${apiBase}/api/v1/:path*` }] : [];
  },
};

export default nextConfig;
