/** Демонстрационные данные. Все названия вымышленные, домены — зарезервированный `.example` (RFC 2606). */
import type { Channel, CrmStage } from "./types";
import type { ScoreInput } from "../scoring";

export interface SeedFact { text: string; kind: "confirmed" | "hypothesis"; path?: string; excerpt?: string; confidence: number }
export interface SeedCompany {
  id: string; name: string; city: string; category: string; domain: string | null; inn?: string;
  input: ScoreInput; stage: CrmStage; daysAgo: number; facts: SeedFact[];
  email?: { masked: string; consent?: "verified" | "withdrawn" }; phone?: string;
}

const base = (o: Partial<ScoreInput>): ScoreInput => ({
  businessType: "autoservice", demandSignals: 2, siteWorks: true, onlineBookingDetected: false,
  hasBusinessContact: true, isDuplicate: false, hasRefusal: false, ...o,
});

export const SEED_COMPANIES: SeedCompany[] = [
  { id: "c1", name: "СТО «Северный мотор»", city: "Санкт-Петербург", category: "Автосервис", domain: "sever-motor.example", input: base({ demandSignals: 3 }), stage: "new", daysAgo: 2,
    email: { masked: "i***@sever-motor.example" },
    facts: [
      { text: "На сайте опубликован перечень ремонтных услуг и цены на ТО", kind: "confirmed", path: "/services", excerpt: "Диагностика, замена масла, ремонт ходовой. Цены от 900 ₽.", confidence: 0.95 },
      { text: "Онлайн-запись на сайте не обнаружена", kind: "hypothesis", path: "/contacts", excerpt: "Запись по телефону с 9:00 до 20:00.", confidence: 0.6 },
    ] },
  { id: "c2", name: "Автоцентр «Пятый бокс»", city: "Казань", category: "СТО", domain: "box-five.example", input: base({ demandSignals: 2 }), stage: "replied", daysAgo: 6,
    email: { masked: "info@box-five.example" },
    facts: [
      { text: "Есть страница с расписанием работы и контактами", kind: "confirmed", path: "/contacts", excerpt: "Пн–Сб 9:00–19:00, Казань, ул. Примерная, 5.", confidence: 0.95 },
      { text: "Форма заявки не найдена", kind: "hypothesis", confidence: 0.5 },
    ] },
  { id: "c3", name: "«МоторЛайн»", city: "Екатеринбург", category: "Автосервис", domain: "motorline.example", input: base({ onlineBookingDetected: true, demandSignals: 3 }), stage: "replied", daysAgo: 12,
    email: { masked: "zakaz@motorline.example", consent: "verified" },
    facts: [
      { text: "Есть форма заявки и каталог услуг", kind: "confirmed", path: "/zapis", excerpt: "Оставьте заявку — мы перезвоним в течение часа.", confidence: 0.95 },
    ] },
  { id: "c4", name: "«Гараж 24»", city: "Новосибирск", category: "СТО", domain: "garage24.example", input: base({ demandSignals: 2 }), stage: "new", daysAgo: 9,
    email: { masked: "garage@garage24.example" }, phone: "+7 *** *** 24-24",
    facts: [{ text: "Есть сайт, отдельная форма записи не найдена", kind: "hypothesis", path: "/", excerpt: "Круглосуточный сервис. Звоните.", confidence: 0.55 },
      { text: "Указан круглосуточный режим работы", kind: "confirmed", path: "/", excerpt: "Круглосуточный сервис.", confidence: 0.9 }] },
  { id: "c5", name: "«АвтоПрофи»", city: "Москва", category: "Шиномонтаж", domain: "autoprofi.example", input: base({ businessType: "adjacent", demandSignals: 1, hasRefusal: true }), stage: "lost", daysAgo: 20,
    email: { masked: "a***@autoprofi.example", consent: "withdrawn" },
    facts: [{ text: "Найдены услуги сезонного шиномонтажа", kind: "confirmed", path: "/tyres", excerpt: "Сезонная замена колёс.", confidence: 0.9 }] },
  { id: "c6", name: "«Драйв-Сервис»", city: "Ростов-на-Дону", category: "Автосервис", domain: "drive-service.example", input: base({ demandSignals: 1, hasBusinessContact: false }), stage: "new", daysAgo: 3,
    facts: [{ text: "Есть контактная информация и цены на часть услуг", kind: "confirmed", path: "/price", excerpt: "Диагностика — 1000 ₽.", confidence: 0.9 }] },
  { id: "c7", name: "СТО «Левша»", city: "Нижний Новгород", category: "Автосервис", domain: "levsha-nn.example", input: base({ demandSignals: 3 }), stage: "new", daysAgo: 15,
    email: { masked: "lev***@levsha-nn.example" },
    facts: [{ text: "Опубликован список услуг по ремонту двигателей", kind: "confirmed", path: "/engine", excerpt: "Капитальный ремонт ДВС.", confidence: 0.95 }] },
  { id: "c8", name: "«Автодок»", city: "Самара", category: "Автосервис", domain: "avtodok-samara.example", input: base({ siteWorks: false, onlineBookingDetected: null, demandSignals: 0 }), stage: "new", daysAgo: 25,
    facts: [{ text: "Сайт недоступен при проверке", kind: "confirmed", confidence: 1 }] },
  { id: "c9", name: "Мастерская «Колесо»", city: "Казань", category: "Шиномонтаж", domain: "koleso-kzn.example", input: base({ businessType: "adjacent", demandSignals: 2 }), stage: "new", daysAgo: 30,
    email: { masked: "k***@koleso-kzn.example" },
    facts: [{ text: "Есть прайс на шиномонтаж", kind: "confirmed", path: "/price", excerpt: "Шиномонтаж от 400 ₽ за колесо.", confidence: 0.9 }] },
  { id: "c10", name: "«Техцентр 66»", city: "Екатеринбург", category: "Автосервис", domain: "tc66.example", input: base({ demandSignals: 2, onlineBookingDetected: null }), stage: "contacted", daysAgo: 18,
    email: { masked: "tc***@tc66.example" },
    facts: [{ text: "Перечень услуг опубликован на сайте", kind: "confirmed", path: "/", excerpt: "Ремонт, ТО, кузовные работы.", confidence: 0.9 }] },
  { id: "c11", name: "«Кузов-Эксперт»", city: "Краснодар", category: "Кузовной ремонт", domain: "kuzov-expert.example", input: base({ businessType: "adjacent", demandSignals: 2 }), stage: "pilot", daysAgo: 40,
    email: { masked: "off***@kuzov-expert.example", consent: "verified" },
    facts: [{ text: "Есть портфолио кузовных работ", kind: "confirmed", path: "/portfolio", excerpt: "Покраска, рихтовка.", confidence: 0.9 }] },
  { id: "c12", name: "«Авторемонт у Михалыча»", city: "Воронеж", category: "Автосервис", domain: null, input: base({ siteWorks: false, onlineBookingDetected: null, demandSignals: 1, hasBusinessContact: true }), stage: "new", daysAgo: 4,
    phone: "+7 *** *** 12-34",
    facts: [{ text: "Сайта нет; найден публичный телефон в каталоге", kind: "hypothesis", confidence: 0.4 }] },
  { id: "c13", name: "ТестАвто (тестовый ящик владельца)", city: "Москва", category: "Автосервис", domain: "testauto.example", input: base({ demandSignals: 2 }), stage: "new", daysAgo: 1,
    email: { masked: "owner-test@testauto.example", consent: "verified" },
    facts: [{ text: "Тестовая запись владельца для проверки цепочки отправки", kind: "confirmed", path: "/", excerpt: "Служебная запись, не реальная компания.", confidence: 1 }] },
  { id: "c14", name: "«Автолидер»", city: "Уфа", category: "Автосервис", domain: "avtolider-ufa.example", input: base({ demandSignals: 1 }), stage: "new", daysAgo: 7,
    email: { masked: "m***@avtolider-ufa.example" },
    facts: [{ text: "Указаны услуги и график работы", kind: "confirmed", path: "/", excerpt: "Ежедневно 10:00–20:00.", confidence: 0.9 }] },
];

export interface SeedMsg { dir: "in" | "out"; text: string; minsAgo: number }
export const SEED_CONVERSATIONS: { id: string; companyId: string; channel: Channel; unread: boolean; msgs: SeedMsg[] }[] = [
  { id: "v1", companyId: "c3", channel: "email", unread: true, msgs: [
    { dir: "out", text: "Здравствуйте! Мы готовим помощника для обработки заявок на обслуживание. Удобно показать пример?", minsAgo: 1500 },
    { dir: "in", text: "Да, интересно. Как будет выглядеть запись и сколько стоит пилот?", minsAgo: 90 } ] },
  { id: "v2", companyId: "c5", channel: "email", unread: false, msgs: [
    { dir: "out", text: "Здравствуйте! Хотим предложить короткую демонстрацию AutoFlow.", minsAgo: 4000 },
    { dir: "in", text: "Спасибо, пока не актуально. Просим больше не писать.", minsAgo: 3000 } ] },
  { id: "v3", companyId: "c2", channel: "email", unread: true, msgs: [
    { dir: "out", text: "Здравствуйте! Предлагаем показать AutoFlow на примере вашей записи.", minsAgo: 2900 },
    { dir: "in", text: "У вас есть интеграция с нашей CRM?", minsAgo: 1440 } ] },
];
