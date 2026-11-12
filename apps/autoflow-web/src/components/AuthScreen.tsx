"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { LogoMark, IconCheck } from "./Icons";
import { appApi, AppError } from "@/lib/app-api";

type Challenge = {
  challenge_id: string;
  expires_in: number;
  resend_in: number;
};
export function AuthScreen({ register = false }: { register?: boolean }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [business, setBusiness] = useState("");
  const [city, setCity] = useState("");
  const [consent, setConsent] = useState(false);
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [code, setCode] = useState("");
  const [verified, setVerified] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryAt, setRetryAt] = useState(0);
  const [now, setNow] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (challenge) input.current?.focus();
  }, [challenge]);
  useEffect(() => {
    if (!retryAt) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [retryAt]);
  const remaining = Math.max(0, Math.ceil((retryAt - now) / 1000));
  const fail = (e: unknown) =>
    setError(
      e instanceof AppError
        ? e.message
        : "Не удалось продолжить. Попробуйте снова.",
    );
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (!challenge) {
        const result = await appApi<Challenge>("/auth/otp/request", "POST", {
          email: email.trim(),
        });
        setChallenge(result);
        setRetryAt(Date.now() + result.resend_in * 1000);
        setNow(Date.now());
      } else {
        if (!verified) {
          await appApi("/auth/otp/verify", "POST", {
            challenge_id: challenge.challenge_id,
            code,
          });
          setVerified(true);
        }
        if (register)
          await appApi("/account", "PUT", {
            name,
            business_name: business,
            city,
            consent,
          });
        router.replace("/app");
      }
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }
  async function resend() {
    if (!challenge || busy || remaining) return;
    setBusy(true);
    setError(null);
    try {
      const result = await appApi<{ resend_in: number }>(
        "/auth/otp/resend",
        "POST",
        { challenge_id: challenge.challenge_id },
      );
      setRetryAt(Date.now() + result.resend_in * 1000);
      setNow(Date.now());
      setCode("");
      input.current?.focus();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="auth-page">
      <Link className="logo" href="/" aria-label="AutoFlow — на главную">
        <LogoMark />
        AutoFlow
      </Link>
      <div className="auth-grid">
        <section className="auth-story">
          <span className="eyebrow">ВАШ РАБОЧИЙ ДЕНЬ. БЕЗ ХАОСА.</span>
          <p className="auth-marketing-heading">
            Больше времени
            <br />
            на хороший сервис.
          </p>
          <p>
            Расписание, услуги и записи клиентов — в одном рабочем пространстве.
          </p>
          <div className="auth-story-line">
            <IconCheck size={18} /> Закрытое тестирование продукта
          </div>
        </section>
        <section className="auth-panel" aria-labelledby="auth-title">
          <span className="small-kicker">AUTOFlow · ЛИЧНЫЙ КАБИНЕТ</span>
          <h1 id="auth-title">
            {challenge
              ? "Проверьте почту"
              : register
                ? "Создайте аккаунт"
                : "С возвращением"}
          </h1>
          <p className="auth-intro">
            {challenge ? (
              <>
                Отправили шестизначный код на <strong>{email}</strong>. Он
                действует {Math.ceil(challenge.expires_in / 60)} минут.
              </>
            ) : register ? (
              "Регистрация открыта. Рабочее пространство пока доступно только администрации."
            ) : (
              "Войдите по коду из письма. Пароль запоминать не нужно."
            )}
          </p>
          <form onSubmit={submit} aria-busy={busy}>
            {!challenge ? (
              <>
                {register && (
                  <>
                    <label htmlFor="reg-name">Ваше имя</label>
                    <input
                      id="reg-name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      required
                      maxLength={80}
                      autoComplete="name"
                    />
                    <label htmlFor="reg-business">Название автосервиса</label>
                    <input
                      id="reg-business"
                      value={business}
                      onChange={(e) => setBusiness(e.target.value)}
                      required
                      maxLength={120}
                      autoComplete="organization"
                    />
                    <label htmlFor="reg-city">Город</label>
                    <input
                      id="reg-city"
                      value={city}
                      onChange={(e) => setCity(e.target.value)}
                      required
                      maxLength={80}
                      autoComplete="address-level2"
                    />
                  </>
                )}
                <label htmlFor="auth-email">Электронная почта</label>
                <input
                  id="auth-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  maxLength={254}
                  autoComplete="email"
                  placeholder="you@company.ru"
                />
                {register && (
                  <label className="auth-consent">
                    <input
                      type="checkbox"
                      checked={consent}
                      onChange={(e) => setConsent(e.target.checked)}
                      required
                    />
                    <span>
                      Согласен на обработку данных по{" "}
                      <Link href="/privacy" target="_blank">
                        политике конфиденциальности
                      </Link>
                      .
                    </span>
                  </label>
                )}
              </>
            ) : (
              <>
                <label htmlFor="auth-code">Код из письма</label>
                <input
                  id="auth-code"
                  ref={input}
                  className="otp-field"
                  value={code}
                  onChange={(e) =>
                    setCode(e.target.value.replace(/\D/g, "").slice(0, 6))
                  }
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  required={!verified}
                  disabled={verified}
                />
              </>
            )}
            {error && (
              <p className="app-error" role="alert">
                {error}
              </p>
            )}
            <button
              className="btn btn--primary auth-submit"
              type="submit"
              disabled={busy}
            >
              {busy
                ? "Подождите…"
                : challenge
                  ? register
                    ? "Завершить регистрацию"
                    : "Войти в AutoFlow"
                  : "Получить код"}
            </button>
          </form>
          {challenge && !verified && (
            <div className="auth-code-actions">
              <button
                type="button"
                disabled={busy || remaining > 0}
                onClick={resend}
              >
                {remaining
                  ? `Отправить снова через ${remaining} с`
                  : "Отправить код снова"}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setChallenge(null);
                  setCode("");
                  setError(null);
                }}
              >
                Изменить почту
              </button>
            </div>
          )}
          <p className="auth-switch">
            {register ? "Уже есть аккаунт?" : "Впервые здесь?"}{" "}
            <Link href={register ? "/login" : "/register"}>
              {register ? "Войти" : "Зарегистрироваться"}
            </Link>
          </p>
          <Link className="auth-back" href="/">
            ← Вернуться на сайт
          </Link>
        </section>
      </div>
    </main>
  );
}
