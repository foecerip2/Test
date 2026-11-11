import type { NextConfig } from "next";

/**
 * Режим данных фиксируется при сборке: NEXT_PUBLIC_DATA_MODE=live, а если она не задана — live при NEXT_PUBLIC_AUTH_MODE=live
 * (чтобы продакшн-сборка из Dockerfile без правок получала живые данные). Значение подставляется статически,
 * поэтому в live-бандле демо-код (mock, seed, демо-вход) вырезается как мёртвый.
 */
const dataEnv = (process.env.NEXT_PUBLIC_DATA_MODE ?? "").trim().toLowerCase();
const dataMode = dataEnv === "live" ? "live" : dataEnv ? "demo" : process.env.NEXT_PUBLIC_AUTH_MODE === "live" ? "live" : "demo";

const config: NextConfig = {
  env: { NEXT_PUBLIC_DATA_MODE: dataMode },
  output: "standalone",
  // Отдельный каталог сборки (например, .next-live для e2e в live-режиме), чтобы не затирать основную сборку.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default config;
