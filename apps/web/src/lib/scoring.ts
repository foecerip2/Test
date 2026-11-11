/** Rule-based скоринг 0–100 (ТЗ §9). Веса: 25/20/15/15/15/10. Каждое решение объяснимо. */

export const SCORE_RULE_VERSION = "rules-v1";

export interface ScoreInput {
  businessType: "autoservice" | "adjacent" | "other";
  demandSignals: number; // число найденных признаков спроса (услуги, цены, расписание…)
  siteWorks: boolean;
  /** true — онлайн-запись обнаружена, false — не обнаружена, null — не проверялось */
  onlineBookingDetected: boolean | null;
  hasBusinessContact: boolean;
  isDuplicate: boolean;
  hasRefusal: boolean;
}

export interface ScoreReason {
  rule: string;
  label: string;
  points: number;
  max: number;
  note: string;
}

export function scoreCompany(i: ScoreInput): { score: number; reasons: ScoreReason[] } {
  const reasons: ScoreReason[] = [
    {
      rule: "business_type", label: "Тип бизнеса", max: 25,
      points: i.businessType === "autoservice" ? 25 : i.businessType === "adjacent" ? 12 : 0,
      note: i.businessType === "autoservice" ? "Автосервис / СТО" : i.businessType === "adjacent" ? "Смежная категория" : "Не целевая категория",
    },
    {
      rule: "demand", label: "Признаки спроса", max: 20,
      points: Math.min(20, Math.max(0, Math.round(i.demandSignals * 7))),
      note: `Найдено признаков: ${i.demandSignals}`,
    },
    {
      rule: "site", label: "Работающий сайт", max: 15,
      points: i.siteWorks ? 15 : 0,
      note: i.siteWorks ? "Сайт доступен" : "Сайт не найден или недоступен",
    },
    {
      rule: "booking", label: "Онлайн-запись не обнаружена", max: 15,
      points: i.siteWorks && i.onlineBookingDetected === false ? 15 : 0,
      note: i.onlineBookingDetected === null ? "Не проверялось — баллы не начислены" : i.onlineBookingDetected ? "Онлайн-запись обнаружена" : "Не обнаружена (это не доказательство её отсутствия)",
    },
    {
      rule: "contact", label: "Разрешённый контакт", max: 15,
      points: i.hasBusinessContact ? 15 : 0,
      note: i.hasBusinessContact ? "Есть публичный бизнес-контакт" : "Контакт не найден",
    },
    {
      rule: "clean", label: "Нет дубликата и отказа", max: 10,
      points: !i.isDuplicate && !i.hasRefusal ? 10 : 0,
      note: i.hasRefusal ? "Есть отказ" : i.isDuplicate ? "Помечен как дубликат" : "Чисто",
    },
  ];
  const score = Math.max(0, Math.min(100, reasons.reduce((s, r) => s + r.points, 0)));
  return { score, reasons };
}
