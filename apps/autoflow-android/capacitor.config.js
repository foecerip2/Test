// Конфигурация оболочки AutoFlow. Адрес сайта берётся из AUTOFLOW_URL (по умолчанию https://autoflow.vaylonet.ru);
// навигация внутри приложения разрешена только на домен этого адреса.
const url = (process.env.AUTOFLOW_URL || "https://autoflow.vaylonet.ru").replace(/\/+$/, "");
const u = new URL(url);
if (u.protocol !== "https:") throw new Error("AUTOFLOW_URL должен начинаться с https://");

module.exports = {
  appId: "ai.vaylonet.autoflow",
  appName: "AutoFlow",
  webDir: "www",
  server: {
    url,
    cleartext: false,
    allowNavigation: [u.hostname],
    errorPath: "error.html",
  },
  android: {
    allowMixedContent: false,
    backgroundColor: "#fbf7f0",
  },
};
