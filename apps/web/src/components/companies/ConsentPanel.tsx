"use client";
import { useState } from "react";
import { Icon } from "../Icon";
import { ConfirmDialog, Modal } from "../Modal";
import { useToast } from "../Toast";
import { Field, Notice, StatusTag } from "../ui";
import { ApiError, getApi, type ConsentState, type Contact } from "@/lib/api";
import { fmtDay } from "@/lib/hooks";

const CHANNEL: Record<string, string> = { email: "Email", max: "MAX", vk: "VK", telegram: "Telegram", phone: "Телефон" };
const CONSENT_LABEL: Record<ConsentState, string> = { unknown: "Согласие не подтверждено", verified: "Согласие подтверждено", denied: "Отказ", withdrawn: "Согласие отозвано", expired: "Согласие истекло" };
const CONSENT_TONE: Record<ConsentState, "neutral" | "green" | "amber" | "red"> = { unknown: "amber", verified: "green", denied: "red", withdrawn: "red", expired: "amber" };

function RecordDialog({ contact, onClose }: { contact: Contact; onClose: () => void }) {
  const toast = useToast();
  const [proofType, setType] = useState("Письменное согласие");
  const [proofRef, setRef] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try { await getApi().consents.record(contact.id, { proofType, proofRef: proofRef.trim() }); toast("Согласие записано"); onClose(); }
    catch (x) { setErr(x instanceof ApiError ? x.message : "Не удалось сохранить"); setBusy(false); }
  }
  return (
    <Modal title="Записать согласие адресата" onClose={onClose}>
      <form onSubmit={save} noValidate>
        <p>Контакт: {contact.valueMasked} ({CHANNEL[contact.channel]}). Запись фиксирует доказательство, а не выдаёт разрешение сама по себе.</p>
        <Field label="Тип доказательства" htmlFor="proof-type">
          <select id="proof-type" className="select" value={proofType} onChange={(e) => setType(e.target.value)}>
            <option>Письменное согласие</option><option>Ответ на письмо с согласием</option><option>Отметка в форме на сайте</option><option>Договор / соглашение</option>
          </select>
        </Field>
        <Field label="Ссылка или номер документа" htmlFor="proof-ref" error={err} hint="Где хранится доказательство: имя файла, номер письма, URL.">
          <input id="proof-ref" className="input" value={proofRef} onChange={(e) => setRef(e.target.value)} aria-invalid={!!err} data-autofocus />
        </Field>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>Отмена</button>
          <button className="btn btn-primary" disabled={busy || !proofRef.trim()}>Записать</button>
        </div>
      </form>
    </Modal>
  );
}

export function ConsentPanel({ contacts }: { contacts: Contact[] }) {
  const toast = useToast();
  const [rec, setRec] = useState<Contact | null>(null);
  const [wd, setWd] = useState<Contact | null>(null);
  const [busy, setBusy] = useState(false);

  async function withdraw() {
    if (!wd) return;
    setBusy(true);
    try { await getApi().consents.withdraw(wd.id); toast("Согласие отозвано, адрес добавлен в список подавления"); }
    catch (x) { toast(x instanceof ApiError ? x.message : "Не удалось отозвать", "error"); }
    setBusy(false); setWd(null);
  }

  if (!contacts.length) return <Notice tone="info" icon="info">Контактов нет. Автоматическая отправка недоступна; создайте задачу на ручной контакт.</Notice>;

  return (
    <div>
      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {contacts.map((k) => (
          <li key={k.id} style={{ padding: "14px 0", borderBottom: "1px solid #f0f3ef" }}>
            <div className="row between">
              <strong><Icon name={k.channel === "phone" ? "phone" : "mail"} /> {CHANNEL[k.channel]} · {k.valueMasked}</strong>
              <StatusTag tone={CONSENT_TONE[k.consent.state]}>{CONSENT_LABEL[k.consent.state]}</StatusTag>
            </div>
            <p className="muted small" style={{ marginTop: 4 }}>{k.role} · основание: {k.legalBasis}{k.lastVerifiedAt ? ` · проверен ${fmtDay(k.lastVerifiedAt)}` : " · не проверялся"}</p>
            {k.consent.proofType && <p className="muted small">Доказательство: {k.consent.proofType} ({k.consent.proofRef}){k.consent.collectedAt ? `, ${fmtDay(k.consent.collectedAt)}` : ""}</p>}
            {k.suppressed && <div style={{ marginTop: 8 }}><Notice tone="danger" icon="lock">Адрес в списке подавления — отправка заблокирована, запись согласия недоступна без нового законного основания.</Notice></div>}
            {!k.platformAllowed && <p className="muted small" style={{ marginTop: 4 }}>Канал не поддерживает автоматическую отправку: только ручной контакт.</p>}
            <div className="row" style={{ marginTop: 10 }}>
              <button className="btn btn-sm" disabled={k.suppressed || k.consent.state === "verified" || !k.platformAllowed} onClick={() => setRec(k)}
                title={k.suppressed ? "Адрес в списке подавления" : !k.platformAllowed ? "Канал без автоматической отправки" : k.consent.state === "verified" ? "Согласие уже подтверждено" : undefined}>Записать согласие<span className="sr-only">: {CHANNEL[k.channel]} {k.valueMasked}</span></button>
              <button className="btn btn-sm btn-danger" disabled={k.consent.state !== "verified" || k.suppressed} onClick={() => setWd(k)}
                title={k.consent.state !== "verified" ? "Нечего отзывать: согласие не подтверждено" : undefined}>Отозвать согласие<span className="sr-only">: {CHANNEL[k.channel]} {k.valueMasked}</span></button>
            </div>
          </li>
        ))}
      </ul>
      {rec && <RecordDialog contact={rec} onClose={() => setRec(null)} />}
      {wd && <ConfirmDialog title="Отозвать согласие?" danger busy={busy} confirmLabel="Отозвать" onCancel={() => setWd(null)} onConfirm={withdraw}
        text={<>Адрес {wd.valueMasked} будет добавлен в список подавления. Все новые рекламные сообщения на него будут заблокированы.</>} />}
    </div>
  );
}
