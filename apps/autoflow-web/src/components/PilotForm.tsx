"use client";

import { useRef, useState } from "react";
import { IconAlert, IconCheck } from "@/components/Icons";
import { siteConfig } from "@/lib/config";
import { submitPilot, type SubmitResult } from "@/lib/pilot-api";
import { validatePilot, type PilotErrorKey, type PilotErrors, type PilotFields } from "@/lib/validate";

const EMPTY: PilotFields = { business_name: "", city: "", contact_name: "", phone: "", email: "", consent: false, website: "" };
type Status = "idle" | "submitting" | "success";
type Failure = Extract<SubmitResult, { ok: false }>["kind"];

const FOCUS_ORDER: PilotErrorKey[] = ["business_name", "city", "contact_name", "contact", "phone", "email", "consent"];
const FOCUS_ID: Record<PilotErrorKey, string> = {
  business_name: "pf-business_name",
  city: "pf-city",
  contact_name: "pf-contact_name",
  contact: "pf-phone",
  phone: "pf-phone",
  email: "pf-email",
  consent: "pf-consent",
};

function failureText(kind: Failure): string {
  switch (kind) {
    case "unavailable":
      return "Заявки временно не принимаются: сервис ещё готовится к запуску. Напишите нам напрямую, и мы ответим.";
    case "invalid":
      return "Сервер не принял данные. Проверьте поля и отправьте ещё раз.";
    case "rate":
      return "Слишком много попыток. Подождите минуту и повторите.";
    case "network":
      return "Нет связи с сервером. Проверьте интернет и повторите попытку.";
    default:
      return "Не удалось отправить заявку. Повторите позже или напишите нам напрямую.";
  }
}

export function PilotForm() {
  const [values, setValues] = useState<PilotFields>(EMPTY);
  const [errors, setErrors] = useState<PilotErrors>({});
  const [status, setStatus] = useState<Status>("idle");
  const [failure, setFailure] = useState<Failure | null>(null);
  const lock = useRef(false); // защита от двойной отправки (до перерисовки)
  const successRef = useRef<HTMLDivElement>(null);

  const set = <K extends keyof PilotFields>(key: K, value: PilotFields[K]) => {
    setValues((v) => ({ ...v, [key]: value }));
    if (key in errors) setErrors((e) => ({ ...e, [key]: undefined }));
    if (key === "phone" || key === "email") setErrors((e) => ({ ...e, contact: undefined }));
  };

  async function onSubmit(ev: React.FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    if (lock.current || status !== "idle") return;
    setFailure(null);
    const res = validatePilot(values);
    if (!res.ok) {
      setErrors(res.errors);
      const first = FOCUS_ORDER.find((k) => res.errors[k]);
      if (first) document.getElementById(FOCUS_ID[first])?.focus();
      return;
    }
    setErrors({});
    lock.current = true;
    setStatus("submitting");
    // Бот заполнил скрытое поле: делаем вид, что всё принято, но ничего не отправляем.
    const out: SubmitResult = values.website.trim() ? { ok: true } : await submitPilot(res.payload);
    lock.current = false;
    if (out.ok) {
      setStatus("success");
      setTimeout(() => successRef.current?.focus(), 0);
    } else {
      setStatus("idle");
      setFailure(out.kind);
    }
  }

  if (status === "success") {
    return (
      <div className="form">
        <div className="success" ref={successRef} tabIndex={-1} role="status">
          <div className="success-ico">
            <IconCheck size={32} />
          </div>
          <h3>Заявка отправлена</h3>
          <p>Спасибо! Мы свяжемся с вами по указанному контакту и обсудим условия пилота.</p>
        </div>
      </div>
    );
  }

  const busy = status === "submitting";
  const err = (k: PilotErrorKey) => (errors[k] ? (
    <p className="err" id={`pf-${k}-err`}>
      {errors[k]}
    </p>
  ) : null);
  const bad = (k: PilotErrorKey) => (errors[k] ? true : undefined);
  const desc = (k: PilotErrorKey, extra?: string) => [errors[k] ? `pf-${k}-err` : "", extra ?? ""].filter(Boolean).join(" ") || undefined;
  const contactErr = errors.contact ? "pf-contact-err" : undefined;

  return (
    <form className="form" onSubmit={onSubmit} noValidate aria-busy={busy} data-testid="pilot-form">
      <div className="form-grid">
        <div className="field span2">
          <label htmlFor="pf-business_name">Название автосервиса</label>
          <input id="pf-business_name" name="business_name" type="text" autoComplete="organization" maxLength={120} value={values.business_name} onChange={(e) => set("business_name", e.target.value)} aria-invalid={bad("business_name")} aria-describedby={desc("business_name")} />
          {err("business_name")}
        </div>
        <div className="field">
          <label htmlFor="pf-city">Город</label>
          <input id="pf-city" name="city" type="text" autoComplete="address-level2" maxLength={80} value={values.city} onChange={(e) => set("city", e.target.value)} aria-invalid={bad("city")} aria-describedby={desc("city")} />
          {err("city")}
        </div>
        <div className="field">
          <label htmlFor="pf-contact_name">Ваше имя</label>
          <input id="pf-contact_name" name="contact_name" type="text" autoComplete="name" maxLength={80} value={values.contact_name} onChange={(e) => set("contact_name", e.target.value)} aria-invalid={bad("contact_name")} aria-describedby={desc("contact_name")} />
          {err("contact_name")}
        </div>

        <fieldset className="contact-group span2">
          <legend className="field" style={{ marginBottom: 8, fontWeight: 600, fontSize: "0.9375rem", padding: 0 }}>
            Как с вами связаться <span className="opt">(достаточно одного способа)</span>
          </legend>
          <div className="contact-pair">
            <div className="field">
              <label htmlFor="pf-phone">Телефон</label>
              <input id="pf-phone" name="phone" type="tel" inputMode="tel" autoComplete="tel" maxLength={32} value={values.phone} onChange={(e) => set("phone", e.target.value)} aria-invalid={bad("phone") ?? bad("contact")} aria-describedby={[desc("phone"), contactErr].filter(Boolean).join(" ") || undefined} />
              {err("phone")}
            </div>
            <div className="field">
              <label htmlFor="pf-email">E-mail</label>
              <input id="pf-email" name="email" type="email" inputMode="email" autoComplete="email" maxLength={254} value={values.email} onChange={(e) => set("email", e.target.value)} aria-invalid={bad("email") ?? bad("contact")} aria-describedby={[desc("email"), contactErr].filter(Boolean).join(" ") || undefined} />
              {err("email")}
            </div>
          </div>
          {errors.contact ? (
            <p className="err" id="pf-contact-err">
              {errors.contact}
            </p>
          ) : null}
        </fieldset>

        {/* Ловушка для ботов: человек поле не видит и не заполняет */}
        <div className="hp" aria-hidden="true">
          <label htmlFor="pf-website">Сайт (не заполняйте)</label>
          <input id="pf-website" name="website" type="text" tabIndex={-1} autoComplete="off" value={values.website} onChange={(e) => set("website", e.target.value)} />
        </div>

        <div className="field span2">
          <label className="consent" htmlFor="pf-consent">
            <input id="pf-consent" name="consent" type="checkbox" checked={values.consent} onChange={(e) => set("consent", e.target.checked)} aria-invalid={bad("consent")} aria-describedby={desc("consent")} />
            <span>
              Даю согласие на обработку персональных данных на условиях{" "}
              <a href="/privacy" target="_blank" rel="noopener noreferrer">
                политики обработки данных
              </a>
              .
            </span>
          </label>
          {err("consent")}
        </div>

        {failure ? (
          <div className="banner span2" role="alert" data-testid="pilot-error" data-kind={failure}>
            <IconAlert size={22} />
            <p>
              {failureText(failure)}
              {failure === "unavailable" || failure === "server" ? (
                <>
                  {" "}
                  <a href={`mailto:${siteConfig.contactEmail}`}>{siteConfig.contactEmail}</a>
                </>
              ) : null}
            </p>
          </div>
        ) : null}

        <div className="form-foot span2">
          <button className="btn btn--primary" type="submit" disabled={busy}>
            {busy ? "Отправляем…" : "Отправить заявку"}
          </button>
          <p className="hint">Заявка ни к чему не обязывает: мы свяжемся и обсудим условия.</p>
        </div>
      </div>
    </form>
  );
}
