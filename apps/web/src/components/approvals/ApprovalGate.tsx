"use client";
import Link from "next/link";
import { Icon } from "../Icon";
import { Notice } from "../ui";
import type { Draft, OutboxPreview, ReasonCode } from "@/lib/api";

export const REASON_TEXT: Record<ReasonCode, string> = {
  EMERGENCY_STOP: "Включён аварийный стоп отправки",
  TEXT_NOT_APPROVED: "Текст не согласован владельцем",
  APPROVAL_STALE: "Одобрение устарело: текст изменён после согласования",
  CONSENT_NOT_VERIFIED: "Согласие адресата не подтверждено",
  CONSENT_WITHDRAWN: "Согласие адресата отозвано",
  SUPPRESSED: "Адрес в списке подавления",
  CHANNEL_NOT_SUPPORTED: "Канал не поддерживает автоматическую отправку — только ручной контакт",
  NO_CONTACT: "Для канала нет контакта",
  ALREADY_QUEUED: "Сообщение уже поставлено в очередь",
};
const CONSENT_TEXT: Record<string, string> = {
  verified: "Согласие подтверждено", unknown: "Согласие не подтверждено", denied: "Адресат отказал", withdrawn: "Согласие отозвано", expired: "Срок согласия истёк",
};

function Item({ ok, title, detail }: { ok: boolean; title: string; detail: string }) {
  return (
    <li className="feed-item" style={{ padding: "10px 0" }}>
      <span className="feed-icon" style={ok ? undefined : { background: "var(--red-tint)", color: "var(--red)" }}><Icon name={ok ? "tick" : "close"} /></span>
      <div className="feed-text"><strong>{title}</strong><p>{ok ? "Выполнено" : "Не выполнено"} · {detail}</p></div>
    </li>
  );
}

export function ApprovalGate({ draft, preview, dirty, busy, onApprove, onReject, onSend }: {
  draft: Draft; preview: OutboxPreview; dirty: boolean; busy: boolean;
  onApprove: () => void; onReject: () => void; onSend: () => void;
}) {
  const approveBlocked = dirty ? "Сначала сохраните изменения текста" : draft.status === "approved" && !draft.approvalStale ? "Текущая версия уже согласована" : null;
  const sendBlocked = dirty ? "Сохраните или отмените несохранённые правки текста" : preview.canSend ? null : preview.reasonCodes.map((c) => REASON_TEXT[c]).join("; ");
  const reasons = preview.reasonCodes;
  return (
    <div className="panel-body">
      <ul className="feed" style={{ padding: 0 }} aria-label="Проверка права отправки">
        <Item ok={preview.ownerApproved} title="Текст согласован владельцем" detail={draft.approvalStale ? "одобрение устарело (текст изменён)" : preview.ownerApproved ? "хэш одобренного текста совпадает" : "требуется согласование"} />
        <Item ok={preview.consentState === "verified" && !!preview.contactId} title="Согласие адресата" detail={preview.contactId ? CONSENT_TEXT[preview.consentState] ?? preview.consentState : "контакт для канала не найден"} />
        <Item ok={!preview.suppressed} title="Нет в списке подавления" detail={preview.suppressed ? "адрес заблокирован" : "блокировок нет"} />
        <Item ok={preview.platformAllowed} title="Канал поддерживает отправку" detail={preview.platformAllowed ? "официальный адаптер доступен" : "только ручной контакт"} />
        <Item ok={!preview.emergencyStop} title="Аварийный стоп выключен" detail={preview.emergencyStop ? "отправка выключена в настройках" : "отправка разрешена"} />
      </ul>
      {reasons.length > 0 && (
        <Notice tone="warn" icon="shield">
          <strong>Отправка заблокирована.</strong> {reasons.map((c) => REASON_TEXT[c]).join("; ")}.
          {preview.nextAction === "record_consent" && <> <Link href={`/companies/${draft.companyId}`}>Записать согласие в карточке компании</Link>.</>}
          {preview.nextAction === "enable_sending" && <> <Link href="/settings">Открыть настройки отправки</Link>.</>}
          {preview.nextAction === "manual_contact" && <> Используйте текст для ручного контакта.</>}
          {preview.nextAction === "approve_text" && <> Согласуйте актуальный текст.</>}
        </Notice>
      )}
      {preview.canSend && <Notice tone="ok" icon="shield">Все проверки пройдены. В демо-режиме отправка не выполняется реально.</Notice>}
      <div className="row spacer-top">
        <button className="btn btn-primary" onClick={onApprove} disabled={busy || !!approveBlocked} aria-describedby={approveBlocked ? "approve-why" : undefined}><Icon name="check" /> Согласовать текст</button>
        <button className="btn btn-danger" onClick={onReject} disabled={busy}><Icon name="close" /> Отклонить</button>
        <button className="btn" onClick={onSend} disabled={busy || dirty || !preview.canSend} aria-describedby={sendBlocked ? "send-why" : undefined}><Icon name="send" /> Отправить</button>
      </div>
      {approveBlocked && <p className="field-hint" id="approve-why">Согласование недоступно: {approveBlocked}.</p>}
      {sendBlocked && <p className="field-hint" id="send-why">Отправка недоступна: {sendBlocked}.</p>}
    </div>
  );
}
