"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { trapDialogFocus } from "./dialog-focus";
import { appApi } from "@/lib/app-api";

type Status = "new" | "contacted" | "accepted" | "declined" | "spam";
interface Pilot {
  id: string;
  business_name: string;
  city: string;
  contact_name: string;
  phone: string | null;
  email: string | null;
  status: Status;
  note: string;
  created_at: string;
  consent_at: string;
}
const LABEL: Record<Status, string> = {
  new: "Новая",
  contacted: "Связались",
  accepted: "Принята в пилот",
  declined: "Отклонена",
  spam: "Спам",
};
const fmt = (date: string) =>
  new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Moscow",
  }).format(new Date(date));
export function PilotInbox() {
  const [status, setStatus] = useState("");
  const [cursors, setCursors] = useState<string[]>([]);
  const [data, setData] = useState<{
    items: Pilot[];
    next_cursor: string | null;
  } | null>(null);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<Pilot | null>(null);
  const [revision, setRevision] = useState(0);
  const cursor = cursors.at(-1);
  useEffect(() => {
    let alive = true;
    setData(null);
    setError("");
    const params = new URLSearchParams({ limit: "25" });
    if (status) params.set("status", status);
    if (cursor) params.set("cursor", cursor);
    appApi<{ items: Pilot[]; next_cursor: string | null }>(
      `/app/pilots?${params}`,
    )
      .then((v) => {
        if (alive) setData(v);
      })
      .catch((e: Error) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [status, cursor, revision]);
  return (
    <section className="schedule-panel">
      <div className="schedule-toolbar">
        <div>
          <h2>Автосервисы с лендинга</h2>
          <p>Контакты для обсуждения пилота · даты по Москве</p>
        </div>
        <label className="pilot-filter">
          Статус
          <select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setCursors([]);
            }}
          >
            <option value="">Все</option>
            {Object.entries(LABEL).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error ? (
        <div className="app-error" role="alert">
          {error}{" "}
          <button onClick={() => setRevision((v) => v + 1)}>Повторить</button>
        </div>
      ) : !data ? (
        <p className="pilot-loading" role="status">
          Загружаем заявки…
        </p>
      ) : !data.items.length ? (
        <div className="workspace-empty">
          <h3>Заявок пока нет</h3>
          <p>Они появятся после отправки формы на лендинге AutoFlow.</p>
        </div>
      ) : (
        <div className="pilot-cards">
          {data.items.map((r) => (
            <article className="pilot-card" key={r.id}>
              <div>
                <h3>{r.business_name}</h3>
                <p>
                  {r.city} · {r.contact_name}
                </p>
              </div>
              <div className="pilot-contact">
                {r.phone && <span>{r.phone}</span>}
                {r.email && <span>{r.email}</span>}
              </div>
              <div className="pilot-card-state">
                <span className={`pilot-tag pilot-tag-${r.status}`}>
                  {LABEL[r.status]}
                </span>
                <time dateTime={r.created_at}>{fmt(r.created_at)}</time>
              </div>
              <button className="btn btn--ghost" onClick={() => setSelected(r)}>
                Открыть
              </button>
            </article>
          ))}
        </div>
      )}
      <div className="pilot-pagination">
        <button
          className="btn btn--ghost"
          disabled={!cursors.length || !data}
          onClick={() => setCursors((v) => v.slice(0, -1))}
        >
          Назад
        </button>
        <span>Страница {cursors.length + 1}</span>
        <button
          className="btn btn--ghost"
          disabled={!data?.next_cursor}
          onClick={() => {
            if (data?.next_cursor) setCursors((v) => [...v, data.next_cursor!]);
          }}
        >
          Далее
        </button>
        <button
          className="pilot-refresh"
          onClick={() => setRevision((v) => v + 1)}
        >
          Обновить
        </button>
      </div>
      {selected && (
        <PilotEdit
          pilot={selected}
          onClose={() => setSelected(null)}
          onSaved={() => {
            setSelected(null);
            setRevision((v) => v + 1);
          }}
        />
      )}
    </section>
  );
}
function PilotEdit({
  pilot,
  onClose,
  onSaved,
}: {
  pilot: Pilot;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [status, setStatus] = useState(pilot.status),
    [note, setNote] = useState(pilot.note),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const errorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (error && !busy) errorRef.current?.focus();
  }, [error, busy]);
  const ref = useRef<HTMLDialogElement>(null),
    lock = useRef(false);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.showModal();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  async function save(e: FormEvent) {
    e.preventDefault();
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await appApi(`/app/pilots/${pilot.id}`, "PATCH", { status, note });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось сохранить");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <dialog
      className="booking-dialog"
      ref={ref}
      onKeyDown={trapDialogFocus}
      aria-labelledby="pilot-edit-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div className="dialog-title">
        <div>
          <span className="small-kicker">ЗАЯВКА НА ПИЛОТ</span>
          <h2 id="pilot-edit-title">{pilot.business_name}</h2>
        </div>
        <button
          className="dialog-close"
          type="button"
          aria-label="Закрыть"
          disabled={busy}
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <p className="pilot-edit-contact">
        {pilot.contact_name} · {pilot.city}
        <br />
        {pilot.phone} {pilot.email}
      </p>
      <p className="pilot-consent">
        Согласие на обработку заявки: {fmt(pilot.consent_at)}. Это не согласие
        на рекламную рассылку.
      </p>
      <form onSubmit={save} aria-busy={busy}>
        <label htmlFor="pilot-edit-status">Статус заявки</label>
        <select
          id="pilot-edit-status"
          value={status}
          disabled={busy}
          onChange={(e) => setStatus(e.target.value as Status)}
        >
          {Object.entries(LABEL).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
        <label htmlFor="pilot-edit-note">Заметка</label>
        <textarea
          id="pilot-edit-note"
          rows={4}
          value={note}
          maxLength={2000}
          disabled={busy}
          onChange={(e) => setNote(e.target.value)}
        />
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
            {busy ? "Сохраняем…" : "Сохранить заявку"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
