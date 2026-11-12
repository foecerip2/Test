"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  LogoMark,
  IconCalendar,
  IconPlus,
  IconCheck,
  IconList,
  IconGrid,
  IconSettings,
} from "../Icons";
import {
  appApi,
  AppError,
  todayMoscow,
  timeLabel,
  timeValue,
  STATUS_LABEL,
  type Account,
  type AppState,
  type Booking,
} from "@/lib/app-api";

type Section = "schedule" | "services" | "resources" | "settings" | "pilots";
import { trapDialogFocus } from "./dialog-focus";
import { PilotInbox } from "./PilotInbox";

const NAV: { section: Section; href: string; label: string; short: string }[] =
  [
    {
      section: "pilots",
      href: "/app/pilots",
      label: "Заявки на пилот",
      short: "Пилот",
    },
    { section: "schedule", href: "/app", label: "Расписание", short: "День" },
    {
      section: "services",
      href: "/app/services",
      label: "Услуги",
      short: "Услуги",
    },
    {
      section: "resources",
      href: "/app/resources",
      label: "Боксы и мастера",
      short: "Боксы",
    },
    {
      section: "settings",
      href: "/app/settings",
      label: "Автосервис",
      short: "Сервис",
    },
  ];
const message = (error: unknown) =>
  error instanceof Error ? error.message : "Не удалось выполнить действие.";
function Banner({ children }: { children: ReactNode }) {
  return (
    <div className="app-error" role="alert">
      {children}
    </div>
  );
}
export function WorkspaceApp({ section = "schedule" }: { section?: Section }) {
  const router = useRouter();
  const [account, setAccount] = useState<Account | null>(null);
  const [data, setData] = useState<AppState | null>(null);
  const [day, setDay] = useState(todayMoscow);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState("");
  const [signingOut, setSigningOut] = useState(false);
  const reload = useCallback(() => setRevision((v) => v + 1), []);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    setData(null);
    (async () => {
      await appApi("/auth/me"); // синхронизирует CSRF-cookie после восстановления сессии
      const me = await appApi<Account>("/account");
      if (!alive) return;
      setAccount(me);
      if (me.access === "admin") {
        const result = await appApi<AppState>(`/app/state?day=${day}`);
        if (alive) setData(result);
      }
    })()
      .catch((e: unknown) => {
        if (!alive) return;
        if (e instanceof AppError && e.status === 401) router.replace("/login");
        else setError(message(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [day, revision, router]);
  async function logout() {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await appApi("/auth/logout", "POST");
      router.replace("/login");
    } catch (e) {
      setError(message(e));
    } finally {
      setSigningOut(false);
    }
  }
  function saved(text: string) {
    setNotice(text);
    setCreating(false);
    reload();
  }
  if (!account && loading)
    return (
      <main className="app-loading" role="status">
        <LogoMark />
        <p>Открываем AutoFlow…</p>
      </main>
    );
  if (!account && error)
    return (
      <main className="app-gate">
        <h1>Не удалось открыть кабинет</h1>
        <Banner>{error}</Banner>
        <button className="btn btn--primary" onClick={reload}>
          Повторить
        </button>
        <Link href="/login">Вернуться ко входу</Link>
      </main>
    );
  if (!account) return null;
  if (account.access !== "admin")
    return (
      <main className="app-gate">
        <Link className="logo" href="/">
          <LogoMark />
          AutoFlow
        </Link>
        <div className="gate-symbol">
          <IconCheck />
        </div>
        <span className="eyebrow">АККАУНТ СОЗДАН</span>
        <h1>Вы в списке ожидания</h1>
        <p>
          Регистрация завершена. Рабочее пространство AutoFlow пока открыто
          только администрации. Ваши данные сохранены.
        </p>
        <p className="muted">{account.user.email}</p>
        {error && <Banner>{error}</Banner>}
        <div className="gate-actions">
          <button className="btn btn--primary" onClick={reload}>
            Проверить доступ
          </button>
          <button
            className="btn btn--ghost"
            disabled={signingOut}
            onClick={logout}
          >
            Выйти
          </button>
        </div>
        <Link href="/">Вернуться на сайт</Link>
      </main>
    );
  const w = data?.workspace;
  const active =
    data?.appointments.filter((b) => b.status !== "cancelled") ?? [];
  return (
    <div className="workspace-shell">
      <a className="skip" href="#workspace-main">
        Перейти к содержимому
      </a>
      <aside className="workspace-side">
        <Link className="logo" href="/app">
          <LogoMark />
          AutoFlow
        </Link>
        <div className="workspace-name">
          <span className="workspace-avatar">
            {(w?.name ?? "A").slice(0, 1)}
          </span>
          <div>
            <strong>{w?.name ?? "Ваш автосервис"}</strong>
            <span>{w?.city ?? "Настройте рабочее пространство"}</span>
          </div>
        </div>
        <span className="side-caption">РАБОЧЕЕ ПРОСТРАНСТВО</span>
        <nav aria-label="Навигация приложения">
          {NAV.map((n) => (
            <Link
              key={n.section}
              href={n.href}
              aria-current={section === n.section ? "page" : undefined}
            >
              <span
                className={`nav-glyph glyph-${n.section}`}
                aria-hidden="true"
              >
                {n.section === "schedule" ? (
                  <IconCalendar size={19} />
                ) : n.section === "services" ? (
                  <IconList size={19} />
                ) : n.section === "resources" ? (
                  <IconGrid size={19} />
                ) : (
                  <IconSettings size={19} />
                )}
              </span>
              <span className="desktop-nav-label">{n.label}</span>
              <span className="mobile-nav-label">{n.short}</span>
            </Link>
          ))}
        </nav>
        <div className="closed-card">
          <span className="closed-dot" /> Закрытое тестирование
          <p>Рабочее пространство доступно администрации.</p>
        </div>
        <div className="workspace-user">
          <span>
            {account.profile?.name ?? "Администратор"}
            <small>{account.user.email}</small>
          </span>
          <button onClick={logout} disabled={signingOut}>
            Выйти
          </button>
        </div>
      </aside>
      <div className="workspace-body">
        <header className="workspace-top">
          <span>
            Рабочее пространство <span className="crumb-divider">/</span>{" "}
            <strong>{NAV.find((n) => n.section === section)?.label}</strong>
          </span>
          <div className="workspace-top-actions">
            <Link href="/">На сайт ↗</Link>
            <button
              className="mobile-logout"
              disabled={signingOut}
              onClick={logout}
            >
              Выйти
            </button>
          </div>
        </header>
        <main id="workspace-main" className="workspace-main" tabIndex={-1}>
          <div className="workspace-heading">
            <div>
              <span className="small-kicker">AUTOFlow · АДМИНИСТРАЦИЯ</span>
              <h1>
                {section === "schedule"
                  ? "Всё по расписанию."
                  : section === "services"
                    ? "Услуги автосервиса"
                    : section === "resources"
                      ? "Боксы и мастера"
                      : section === "pilots"
                        ? "Заявки на пилот"
                        : "Ваш автосервис"}
              </h1>
              <p>
                {section === "schedule"
                  ? "Один день. Все записи. Ничего не потеряется."
                  : section === "services"
                    ? "Длительность услуги определяет занятое время в расписании."
                    : section === "resources"
                      ? "У каждого бокса или мастера — своя очередь записей."
                      : "Название и рабочие часы, которые используются для записи."}
              </p>
            </div>
            {section === "schedule" && w && (
              <button
                className="btn btn--primary"
                onClick={() => {
                  setNotice("");
                  setCreating(true);
                }}
                disabled={
                  !data?.services.length || !data?.resources.length || loading
                }
              >
                <IconPlus size={18} /> Новая запись
              </button>
            )}
          </div>
          {notice && (
            <p className="app-success" role="status">
              <IconCheck size={18} />
              {notice}
            </p>
          )}
          {error && (
            <Banner>
              {error} <button onClick={reload}>Повторить</button>
            </Banner>
          )}
          {loading ? (
            <div
              className="workspace-skeleton"
              role="status"
              aria-label="Загрузка данных"
            >
              <span />
              <span />
              <span />
            </div>
          ) : (
            data &&
            (section === "pilots" ? (
              <PilotInbox />
            ) : !w ? (
              <WorkspaceForm
                initial={
                  account.profile
                    ? {
                        name: account.profile.business_name,
                        city: account.profile.city,
                        opens: 540,
                        closes: 1140,
                      }
                    : undefined
                }
                onSaved={() =>
                  saved("Автосервис создан. Добавьте услуги и боксы.")
                }
              />
            ) : section === "settings" ? (
              <WorkspaceForm
                initial={w}
                onSaved={() => saved("Настройки сохранены")}
              />
            ) : section === "services" ? (
              <Catalog
                kind="services"
                data={data}
                onSaved={() => saved("Услуга добавлена")}
              />
            ) : section === "resources" ? (
              <Catalog
                kind="resources"
                data={data}
                onSaved={() => saved("Бокс добавлен")}
              />
            ) : (
              <>
                <div className="workspace-metrics">
                  <div>
                    <span>Записи на день</span>
                    <strong>{active.length}</strong>
                    <small>Без отменённых</small>
                  </div>
                  <div>
                    <span>Ожидают подтверждения</span>
                    <strong>
                      {active.filter((b) => b.status === "new").length}
                    </strong>
                    <small>Требуют вашего внимания</small>
                  </div>
                  <div>
                    <span>Рабочих боксов</span>
                    <strong>{data.resources.length}</strong>
                    <small>Ресурсы автосервиса</small>
                  </div>
                </div>
                <section
                  className="schedule-panel"
                  aria-label="Расписание на день"
                >
                  <div className="schedule-toolbar">
                    <div>
                      <h2>Расписание</h2>
                      <p>
                        Московское время · {timeLabel(w.opens)}–
                        {timeLabel(w.closes)}
                      </p>
                    </div>
                    <label className="day-picker">
                      Дата
                      <input
                        type="date"
                        value={day}
                        onChange={(e) => {
                          if (e.target.value) {
                            setDay(e.target.value);
                            setNotice("");
                          }
                        }}
                      />
                    </label>
                  </div>
                  {!data.services.length || !data.resources.length ? (
                    <div className="workspace-empty">
                      <IconCalendar size={32} />
                      <h3>Подготовьте расписание</h3>
                      <p>
                        Добавьте хотя бы одну услугу и один бокс — после этого
                        можно создавать записи.
                      </p>
                      <div>
                        <Link className="btn btn--ghost" href="/app/services">
                          Добавить услугу
                        </Link>
                        <Link className="btn btn--ghost" href="/app/resources">
                          Добавить бокс
                        </Link>
                      </div>
                    </div>
                  ) : !data.appointments.length ? (
                    <div className="workspace-empty">
                      <IconCalendar size={32} />
                      <h3>День свободен</h3>
                      <p>
                        Создайте первую запись. Она сохранится на сервере и
                        появится в расписании.
                      </p>
                      <button
                        className="btn btn--primary"
                        onClick={() => setCreating(true)}
                      >
                        Создать запись
                      </button>
                    </div>
                  ) : (
                    <div className="schedule-rows">
                      {data.appointments.map((b) => (
                        <BookingRow
                          key={b.id}
                          booking={b}
                          data={data}
                          onSaved={() => saved("Статус записи обновлён")}
                        />
                      ))}
                    </div>
                  )}
                </section>
              </>
            ))
          )}
          <p className="workspace-foot">
            AutoFlow · закрытая версия для администрации. Публичная запись
            клиентов ещё не открыта.
          </p>
        </main>
      </div>
      {creating && data?.workspace && (
        <BookingDialog
          data={data}
          day={day}
          onClose={() => setCreating(false)}
          onSaved={() => saved("Запись создана")}
        />
      )}
    </div>
  );
}

function WorkspaceForm({
  initial,
  onSaved,
}: {
  initial?: { name: string; city: string; opens: number; closes: number };
  onSaved: () => void;
}) {
  const [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      await appApi("/app/workspace", "PUT", {
        name: form.get("name"),
        city: form.get("city"),
        opens: timeValue(String(form.get("opens"))),
        closes: timeValue(String(form.get("closes"))),
      });
      onSaved();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="workspace-form-panel">
      <div>
        <span className="small-kicker">НАСТРОЙКА</span>
        <h2>{initial ? "Настройки автосервиса" : "Создадим ваш автосервис"}</h2>
        <p>
          Начните с названия и рабочих часов. Затем добавьте услуги и боксы.
        </p>
      </div>
      <form onSubmit={submit} aria-busy={busy}>
        <div className="form-columns">
          <div>
            <label htmlFor="ws-name">Название автосервиса</label>
            <input
              id="ws-name"
              name="name"
              defaultValue={initial?.name}
              maxLength={120}
              required
            />
          </div>
          <div>
            <label htmlFor="ws-city">Город</label>
            <input
              id="ws-city"
              name="city"
              defaultValue={initial?.city}
              maxLength={80}
              required
            />
          </div>
          <div>
            <label htmlFor="ws-opens">Начало рабочего дня</label>
            <input
              id="ws-opens"
              name="opens"
              type="time"
              step={900}
              defaultValue={timeLabel(initial?.opens ?? 540)}
              required
            />
          </div>
          <div>
            <label htmlFor="ws-closes">Конец рабочего дня</label>
            <input
              id="ws-closes"
              name="closes"
              type="time"
              step={900}
              defaultValue={timeLabel(initial?.closes ?? 1140)}
              required
            />
          </div>
        </div>
        {error && <Banner>{error}</Banner>}
        <button className="btn btn--primary" disabled={busy}>
          {busy ? "Сохраняем…" : "Сохранить автосервис"}
        </button>
      </form>
    </section>
  );
}
function Catalog({
  kind,
  data,
  onSaved,
}: {
  kind: "services" | "resources";
  data: AppState;
  onSaved: () => void;
}) {
  const [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  const service = kind === "services";
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const form = e.currentTarget,
      values = new FormData(form);
    setBusy(true);
    setError(null);
    try {
      await appApi(`/app/${kind}`, "POST", {
        name: values.get("name"),
        ...(service
          ? {
              duration: Number(values.get("duration")),
              price: Number(values.get("price")),
            }
          : {}),
      });
      form.reset();
      onSaved();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="catalog-grid">
      <section className="schedule-panel">
        <div className="schedule-toolbar">
          <h2>{service ? "Список услуг" : "Рабочие ресурсы"}</h2>
          <span className="pill">
            {service ? data.services.length : data.resources.length}
          </span>
        </div>
        {service ? (
          data.services.length ? (
            data.services.map((s) => (
              <div className="catalog-row" key={s.id}>
                <strong>{s.name}</strong>
                <span>
                  {s.duration} мин · {s.price.toLocaleString("ru-RU")} ₽
                </span>
              </div>
            ))
          ) : (
            <div className="workspace-empty">
              <h3>Добавьте первую услугу</h3>
              <p>Например, диагностику или замену масла.</p>
            </div>
          )
        ) : data.resources.length ? (
          data.resources.map((r) => (
            <div className="catalog-row" key={r.id}>
              <strong>{r.name}</strong>
              <span>Доступен для записи</span>
            </div>
          ))
        ) : (
          <div className="workspace-empty">
            <h3>Добавьте первый бокс</h3>
            <p>Это может быть рабочее место или мастер.</p>
          </div>
        )}
      </section>
      <section className="workspace-form-panel">
        <h2>{service ? "Новая услуга" : "Новый бокс или мастер"}</h2>
        <form onSubmit={submit} aria-busy={busy}>
          <label htmlFor="item-name">Название</label>
          <input
            id="item-name"
            name="name"
            required
            maxLength={service ? 120 : 80}
            placeholder={service ? "Диагностика" : "Бокс 1"}
          />
          {service && (
            <>
              <label htmlFor="item-duration">Продолжительность, минут</label>
              <input
                id="item-duration"
                name="duration"
                type="number"
                min={15}
                max={480}
                step={15}
                defaultValue={60}
                required
              />
              <label htmlFor="item-price">Стоимость, ₽</label>
              <input
                id="item-price"
                name="price"
                type="number"
                min={0}
                max={1000000}
                step={1}
                defaultValue={0}
                required
              />
            </>
          )}
          {error && <Banner>{error}</Banner>}
          <button className="btn btn--primary" disabled={busy}>
            {busy
              ? "Добавляем…"
              : service
                ? "Добавить услугу"
                : "Добавить бокс"}
          </button>
        </form>
      </section>
    </div>
  );
}
function BookingRow({
  booking: b,
  data,
  onSaved,
}: {
  booking: Booking;
  data: AppState;
  onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  async function update(status: string) {
    setBusy(true);
    setError(null);
    try {
      await appApi(`/app/appointments/${b.id}`, "PATCH", { status });
      onSaved();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <article className={`booking-row booking-${b.status}`}>
      <div className="booking-time">
        <strong>{timeLabel(b.starts)}</strong>
        <span>{timeLabel(b.ends)}</span>
      </div>
      <div className="booking-info">
        <h3>
          {data.services.find((s) => s.id === b.service_id)?.name ?? "Услуга"}
        </h3>
        <p>
          {b.customer} · {b.phone}
        </p>
        {b.note && <p className="booking-note">{b.note}</p>}
      </div>
      <span className="booking-resource">
        {data.resources.find((r) => r.id === b.resource_id)?.name}
      </span>
      <div className="booking-status">
        <label className="sr-only" htmlFor={`status-${b.id}`}>
          Статус записи: {b.customer}
        </label>
        <select
          id={`status-${b.id}`}
          value={b.status}
          disabled={busy}
          onChange={(e) => update(e.target.value)}
        >
          {Object.entries(STATUS_LABEL).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
        {error && <p role="alert">{error}</p>}
      </div>
    </article>
  );
}
function BookingDialog({
  data,
  day,
  onClose,
  onSaved,
}: {
  data: AppState;
  day: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (error && !busy) errorRef.current?.focus();
  }, [error, busy]);
  const lock = useRef(false),
    dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (lock.current) return;
    const f = new FormData(e.currentTarget);
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      await appApi("/app/appointments", "POST", {
        service_id: f.get("service"),
        resource_id: f.get("resource"),
        day: f.get("day"),
        starts: timeValue(String(f.get("time"))),
        customer: f.get("customer"),
        phone: f.get("phone"),
        note: f.get("note"),
        consent: f.get("consent") === "on",
      });
      onSaved();
    } catch (e) {
      setError(message(e));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      onKeyDown={trapDialogFocus}
      className="booking-dialog"
      aria-labelledby="booking-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div className="dialog-title">
        <div>
          <span className="small-kicker">РАСПИСАНИЕ</span>
          <h2 id="booking-title">Новая запись</h2>
        </div>
        <button
          className="dialog-close"
          type="button"
          onClick={onClose}
          disabled={busy}
          aria-label="Закрыть"
        >
          ×
        </button>
      </div>
      <form onSubmit={submit} aria-busy={busy}>
        <fieldset disabled={busy}>
          <div className="form-columns">
            <div>
              <label htmlFor="book-service">Услуга</label>
              <select id="book-service" name="service" required>
                {data.services.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} · {s.duration} мин
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="book-resource">Бокс или мастер</label>
              <select id="book-resource" name="resource" required>
                {data.resources.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="book-day">Дата записи</label>
              <input
                id="book-day"
                type="date"
                name="day"
                min={todayMoscow()}
                defaultValue={day < todayMoscow() ? todayMoscow() : day}
                required
              />
            </div>
            <div>
              <label htmlFor="book-time">Время</label>
              <input
                id="book-time"
                type="time"
                name="time"
                step={900}
                defaultValue={timeLabel(data.workspace!.opens)}
                required
              />
            </div>
            <div>
              <label htmlFor="book-customer">Имя клиента</label>
              <input
                id="book-customer"
                name="customer"
                maxLength={80}
                required
              />
            </div>
            <div>
              <label htmlFor="book-phone">Телефон клиента</label>
              <input
                id="book-phone"
                name="phone"
                type="tel"
                maxLength={32}
                placeholder="+7"
                required
              />
            </div>
          </div>
          <label htmlFor="book-note">Комментарий</label>
          <textarea id="book-note" name="note" rows={2} maxLength={1000} />
          <label className="auth-consent">
            <input name="consent" type="checkbox" required />
            <span>Есть согласие клиента на запись и обработку данных.</span>
          </label>
        </fieldset>
        {error && (
          <p className="app-error" role="alert" tabIndex={-1} ref={errorRef}>
            {error}
          </p>
        )}
        <div className="booking-actions">
          <button
            className="btn btn--ghost"
            type="button"
            disabled={busy}
            onClick={onClose}
          >
            Отмена
          </button>
          <button className="btn btn--primary" disabled={busy}>
            {busy ? "Создаём…" : "Создать запись"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
