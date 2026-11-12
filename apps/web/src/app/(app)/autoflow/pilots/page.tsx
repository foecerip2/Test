"use client";
import { useState, type FormEvent } from "react";
import { Modal } from "@/components/Modal";
import { useToast } from "@/components/Toast";
import { Async, EmptyState, ErrorState, LoadingSkeleton, Notice, PageHeader, Panel, StatusTag } from "@/components/ui";
import { ApiError, getApi, type PilotRequest, type PilotStatus } from "@/lib/api";
import { fmtDate, useDocumentTitle, useQuery } from "@/lib/hooks";
import { PILOT_LABEL, PILOT_TONE } from "@/lib/pilots";
import styles from "./pilots.module.css";

export default function PilotsPage() {
  useDocumentTitle("Заявки AutoFlow");
  const me = useQuery((a) => a.auth.me());
  const header = <PageHeader eyebrow="AutoFlow · пилот" title="Заявки автосервисов" subtitle="Контакты с лендинга AutoFlow. Свяжитесь с автосервисом и отметьте результат." />;
  if (me.loading) return <>{header}<LoadingSkeleton rows={3} /></>;
  if (me.error) return <>{header}<ErrorState error={me.error} onRetry={me.reload} /></>;
  if (!me.data || me.data.role !== "owner" || me.data.status !== "active") return <>{header}<ErrorState error={new ApiError(403, "FORBIDDEN", "Заявки доступны только владельцу.")} /></>;
  if (process.env.NEXT_PUBLIC_DATA_MODE !== "live") return <>{header}<Notice tone="info">Заявки на пилот доступны в рабочем режиме. Демо-заявки не создаются.</Notice></>;
  return <>{header}<PilotList /></>;
}

function PilotList() {
  const [status, setStatus] = useState<PilotStatus | "">("");
  const [cursors, setCursors] = useState<string[]>([]);
  const cursor = cursors.at(-1);
  const q = useQuery((a) => a.pilotRequests.list({ status: status || undefined, cursor }), [status, cursor]);
  const [selected, setSelected] = useState<PilotRequest | null>(null);
  return (
    <Panel title="Заявки на пилот" subtitle="Последние заявки — в начале списка. Все даты — по Москве.">
      <div className={`panel-body ${styles.toolbar}`}>
        <label htmlFor="pilot-status">Статус</label>
        <select id="pilot-status" className="select" value={status} onChange={(e) => { setStatus(e.target.value as PilotStatus | ""); setCursors([]); }}>
          <option value="">Все статусы</option>
          {Object.entries(PILOT_LABEL).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>
        <button className="btn" onClick={q.reload} disabled={q.loading}>Обновить</button>
      </div>
      {q.error && q.data && <div role="alert" className="panel-body"><Notice tone="danger">Не удалось обновить заявки. <button className="link-btn" onClick={q.reload}>Повторить</button></Notice></div>}
      <Async q={q} rows={4}>
        {(data) => <>
          {!data.items.length ? <EmptyState title="Заявок пока нет" text={status ? "С этим статусом нет заявок. Выберите другой фильтр." : "Они появятся после отправки формы на лендинге AutoFlow."} /> : (
            <ul className={styles.list} aria-label="Заявки на пилот">
              {data.items.map((r) => <li key={r.id} className={styles.row}>
                <div className={styles.business}><strong>{r.businessName}</strong><span>{r.city} · {r.contactName}</span></div>
                <div className={styles.contact}>{r.phone && <span>{r.phone}</span>}{r.email && <span>{r.email}</span>}</div>
                <div className={styles.meta}><StatusTag tone={PILOT_TONE[r.status]}>{PILOT_LABEL[r.status]}</StatusTag><time dateTime={r.createdAt}>{fmtDate(r.createdAt)}</time></div>
                <button className="btn" onClick={() => setSelected(r)} aria-label={`Открыть заявку: ${r.businessName}`}>Открыть</button>
              </li>)}
            </ul>
          )}
          <div className={`panel-body ${styles.paging}`}>
            <span role="status">Страница {cursors.length + 1} · заявок: {data.items.length}</span>
            <button className="btn" disabled={!cursors.length} onClick={() => setCursors((prev) => prev.slice(0, -1))}>Назад</button>
            <button className="btn" disabled={!data.nextCursor} onClick={() => { if (data.nextCursor) setCursors((prev) => [...prev, data.nextCursor!]); }}>Далее</button>
          </div>
        </>}
      </Async>
      {selected && <PilotEditor key={selected.id} request={selected} onClose={() => setSelected(null)} />}
    </Panel>
  );
}

function PilotEditor({ request, onClose }: { request: PilotRequest; onClose: () => void }) {
  const [status, setStatus] = useState(request.status);
  const [note, setNote] = useState(request.note);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const changed = status !== request.status || note !== request.note;
  async function save(e: FormEvent) {
    e.preventDefault();
    if (busy || !changed) return;
    setBusy(true); setError(null);
    try {
      await getApi().pilotRequests.update(request.id, { ...(status !== request.status ? { status } : {}), ...(note !== request.note ? { note } : {}) });
      toast("Заявка сохранена"); onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Не удалось сохранить заявку. Повторите попытку.");
    } finally { setBusy(false); }
  }
  return <Modal title={request.businessName} onClose={() => { if (!busy) onClose(); }}>
    <form onSubmit={save} aria-busy={busy} className={styles.editor}>
      <p>{request.city} · {request.contactName}</p>
      <div className={styles.contact}>
        {request.phone && <span>Телефон: {request.phone}</span>}
        {request.email && <span>E-mail: {request.email}</span>}
      </div>
      <p className={styles.consent}>Получена {fmtDate(request.createdAt)}. Согласие на обработку данных: {fmtDate(request.consentAt)}, версия {request.consentTextVersion}. Это согласие на обработку заявки, а не на рекламную рассылку.</p>
      <label className="field-label" htmlFor="pilot-edit-status">Статус заявки</label>
      <select id="pilot-edit-status" className="select" disabled={busy} value={status} onChange={(e) => setStatus(e.target.value as PilotStatus)}>
        {Object.entries(PILOT_LABEL).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select>
      <label className="field-label" htmlFor="pilot-note">Заметка владельца</label>
      <textarea id="pilot-note" className={`input ${styles.note}`} rows={5} maxLength={2000} disabled={busy} value={note} onChange={(e) => setNote(e.target.value)} aria-describedby="pilot-note-hint" />
      <p id="pilot-note-hint" className={styles.consent}>До 2000 символов. Не добавляйте лишние персональные данные.</p>
      {error && <div role="alert"><Notice tone="danger">{error}</Notice></div>}
      <div className="dialog-actions">
        <button type="button" className="btn" disabled={busy} onClick={onClose}>Отмена</button>
        <button type="submit" className="btn btn-primary" disabled={busy || !changed}>{busy ? "Сохраняем…" : "Сохранить"}</button>
      </div>
    </form>
  </Modal>;
}
