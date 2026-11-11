export type PilotFields = {
  business_name: string;
  city: string;
  contact_name: string;
  phone: string;
  email: string;
  consent: boolean;
  /** Honeypot: человек его не видит и не заполняет. */
  website: string;
};

export type PilotErrorKey = "business_name" | "city" | "contact_name" | "contact" | "phone" | "email" | "consent";
export type PilotErrors = Partial<Record<PilotErrorKey, string>>;

export type PilotPayload = {
  business_name: string;
  city: string;
  contact_name: string;
  phone: string | null;
  email: string | null;
  consent: true;
  website: string;
};

const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}$/;

/** Телефон → +7XXXXXXXXXX (РФ) или +<цифры> (международный). null — не похоже на телефон. */
export function normalizePhone(raw: string): string | null {
  const s = raw.trim();
  if (!s || !/^[+\d\s().-]+$/.test(s)) return null;
  const digits = s.replace(/\D/g, "");
  if (s.startsWith("+")) return digits.length >= 10 && digits.length <= 15 ? `+${digits}` : null;
  if (digits.length === 11 && (digits[0] === "8" || digits[0] === "7")) return `+7${digits.slice(1)}`;
  if (digits.length === 10) return `+7${digits}`;
  return null;
}

export function isEmail(raw: string): boolean {
  const s = raw.trim();
  return s.length <= 254 && EMAIL_RE.test(s);
}

function textError(value: string, label: string, min: number, max: number): string | undefined {
  const v = value.trim();
  if (!v) return `Укажите ${label}`;
  if (v.length < min) return `Слишком коротко: минимум ${min} символа`;
  if (v.length > max) return `Слишком длинно: максимум ${max} символов`;
  return undefined;
}

export function validatePilot(f: PilotFields): { ok: true; payload: PilotPayload } | { ok: false; errors: PilotErrors } {
  const errors: PilotErrors = {};
  const set = (k: PilotErrorKey, m: string | undefined) => {
    if (m) errors[k] = m;
  };
  set("business_name", textError(f.business_name, "название автосервиса", 2, 120));
  set("city", textError(f.city, "город", 2, 80));
  set("contact_name", textError(f.contact_name, "имя", 2, 80));

  const phone = f.phone.trim() ? normalizePhone(f.phone) : null;
  const email = f.email.trim();
  if (f.phone.trim() && !phone) errors.phone = "Проверьте номер: например, +7 900 000-00-00";
  if (email && !isEmail(email)) errors.email = "Проверьте e-mail: например, name@example.com";
  if (!f.phone.trim() && !email) errors.contact = "Оставьте телефон или e-mail, чтобы мы могли ответить";
  if (!f.consent) errors.consent = "Нужно согласие на обработку персональных данных";

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    payload: {
      business_name: f.business_name.trim(),
      city: f.city.trim(),
      contact_name: f.contact_name.trim(),
      phone,
      email: email || null,
      consent: true,
      website: f.website,
    },
  };
}
