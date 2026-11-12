/** Реальное приложение: cookie-сессия AutoFlow, CSRF; не использует mock/localStorage. */
export interface Account {
  user: { id: string; email: string };
  profile: { name: string; business_name: string; city: string } | null;
  access: "admin" | "waiting";
}
export interface Workspace {
  id: string;
  name: string;
  city: string;
  opens: number;
  closes: number;
}
export interface Service {
  id: string;
  name: string;
  duration: number;
  price: number;
}
export interface Resource {
  id: string;
  name: string;
}
export type BookingStatus = "new" | "confirmed" | "completed" | "cancelled";
export interface Booking {
  id: string;
  service_id: string;
  resource_id: string;
  day: string;
  starts: number;
  ends: number;
  customer: string;
  phone: string;
  note: string;
  status: BookingStatus;
}
export interface AppState {
  workspace: Workspace | null;
  services: Service[];
  resources: Resource[];
  appointments: Booking[];
}
export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
const ERRORS: Record<string, string> = {
  NETWORK: "Нет соединения с сервером. Повторите попытку.",
  MAIL_UNAVAILABLE: "Не удалось отправить письмо. Попробуйте позже.",
  INVALID_CODE: "Неверный код. Проверьте письмо и попробуйте ещё раз.",
  CODE_EXPIRED: "Код истёк. Запросите новый.",
  CODE_USED: "Этот код уже использован. Запросите новый.",
  TOO_MANY_ATTEMPTS: "Слишком много попыток. Запросите новый код.",
  RATE_LIMITED: "Слишком много запросов. Подождите немного.",
  FORBIDDEN: "Рабочий кабинет пока доступен только администрации.",
  CSRF_FAILED: "Сессия устарела. Обновите страницу.",
  SLOT_TAKEN: "Это время уже занято. Выберите другое время или бокс.",
  OUTSIDE_HOURS: "Запись должна помещаться в рабочие часы с шагом 15 минут.",
  PAST_APPOINTMENT: "Нельзя создать запись в прошлом.",
  VALIDATION_ERROR: "Проверьте заполнение полей.",
  ACCOUNT_BLOCKED: "Доступ к аккаунту заблокирован.",
  ORIGIN_FORBIDDEN: "Запрос отклонён сервером. Попробуйте обновить страницу.",
};
export async function appApi<T>(
  path: string,
  method = "GET",
  body?: object,
): Promise<T> {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 15000);
  const headers: Record<string, string> = { Accept: "application/json" };
  if (body) headers["Content-Type"] = "application/json";
  if (method !== "GET" && !path.startsWith("/auth/otp/")) {
    const cookie =
      typeof document === "undefined"
        ? null
        : document.cookie
            .split(";")
            .map((v) => v.trim())
            .find((v) => v.startsWith("af_csrf="));
    if (cookie) headers["X-CSRF-Token"] = decodeURIComponent(cookie.slice(8));
  }
  try {
    const response = await fetch(`/api/v1/autoflow${path}`, {
      method,
      body: body ? JSON.stringify(body) : undefined,
      headers,
      credentials: "same-origin",
      cache: "no-store",
      signal: ctrl.signal,
    });
    if (response.status === 204) return undefined as T;
    let data: Record<string, unknown> | null = null;
    try {
      data = await response.json();
    } catch {
      /* Прокси может вернуть HTML. */
    }
    if (!response.ok) {
      const code = typeof data?.code === "string" ? data.code : "UNKNOWN";
      throw new AppError(
        response.status,
        code,
        ERRORS[code] ??
          (response.status >= 500
            ? "Сервис временно недоступен. Попробуйте позже."
            : "Не удалось выполнить запрос."),
      );
    }
    if (!data)
      throw new AppError(
        502,
        "INVALID_RESPONSE",
        "Не удалось прочитать ответ сервера.",
      );
    return data as T;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(0, "NETWORK", ERRORS.NETWORK!);
  } finally {
    clearTimeout(timeout);
  }
}
export const todayMoscow = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
export const timeLabel = (value: number) =>
  `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
export const timeValue = (value: string) => {
  const [h, m] = value.split(":").map(Number);
  return h! * 60 + m!;
};
export const STATUS_LABEL: Record<BookingStatus, string> = {
  new: "Новая",
  confirmed: "Подтверждена",
  completed: "Выполнена",
  cancelled: "Отменена",
};
