"use client";
// STUB: заменяется реализацией (владелец — агент «discovery»). Контракт: { onClose } и закрытие по завершению импорта.
import { Modal } from "../Modal";
export function ImportWizard({ onClose }: { onClose: () => void }) {
  return (<Modal title="Импорт CSV" onClose={onClose}><p>Скоро</p><div className="dialog-actions"><button className="btn" onClick={onClose}>Закрыть</button></div></Modal>);
}
