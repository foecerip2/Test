"use client";
// STUB: заменяется реализацией (владелец — агент «companies»). Контракт: { companyId, onClose, onCreated? }.
import { Modal } from "../Modal";
export function TaskDialog({ companyId, onClose }: { companyId: string | null; onClose: () => void; onCreated?: () => void }) {
  return (<Modal title="Новая задача" onClose={onClose}><p>Скоро {companyId}</p><div className="dialog-actions"><button className="btn" onClick={onClose}>Закрыть</button></div></Modal>);
}
