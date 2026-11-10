"use client";
// Контракт props: { companyId, onClose, onCreated? } — используется также страницей «Диалоги».
import { useState } from "react";
import { Modal } from "../Modal";
import { useToast } from "../Toast";
import { Field } from "../ui";
import { ApiError, getApi, type Task, type TaskType } from "@/lib/api";

const TYPES: { id: TaskType; label: string }[] = [
  { id: "follow_up", label: "Напоминание / follow-up" }, { id: "demo", label: "Демонстрация" },
  { id: "call", label: "Звонок" }, { id: "manual_contact", label: "Ручной контакт" },
];
const dayIso = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

export function TaskDialog({ companyId, onClose, onCreated }: { companyId: string | null; onClose: () => void; onCreated?: () => void }) {
  const toast = useToast();
  const [title, setTitle] = useState("");
  const [type, setType] = useState<TaskType>("follow_up");
  const [due, setDue] = useState(dayIso(1));
  const [priority, setPriority] = useState<Task["priority"]>("normal");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) { setErr("Укажите название задачи"); return; }
    setBusy(true); setErr(null);
    try {
      await getApi().tasks.create({ companyId, title: title.trim(), type, dueAt: new Date(`${due}T09:00:00`).toISOString(), priority });
      toast("Задача создана"); onCreated?.(); onClose();
    } catch (x) { setErr(x instanceof ApiError ? x.message : "Не удалось создать задачу"); setBusy(false); }
  }

  return (
    <Modal title="Новая задача" onClose={onClose}>
      <form onSubmit={save} noValidate>
        <Field label="Название" htmlFor="task-title" error={err}>
          <input id="task-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} aria-invalid={!!err} data-autofocus />
        </Field>
        <Field label="Тип" htmlFor="task-type">
          <select id="task-type" className="select" value={type} onChange={(e) => setType(e.target.value as TaskType)}>{TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}</select>
        </Field>
        <div className="row" style={{ alignItems: "flex-start" }}>
          <div style={{ flex: 1, minWidth: 140 }}><Field label="Срок" htmlFor="task-due"><input id="task-due" type="date" className="input" value={due} min={dayIso(0)} onChange={(e) => setDue(e.target.value)} /></Field></div>
          <div style={{ flex: 1, minWidth: 140 }}><Field label="Приоритет" htmlFor="task-prio">
            <select id="task-prio" className="select" value={priority} onChange={(e) => setPriority(e.target.value as Task["priority"])}>
              <option value="low">Низкий</option><option value="normal">Обычный</option><option value="high">Высокий</option></select></Field></div>
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>Отмена</button>
          <button className="btn btn-primary" disabled={busy}>Создать задачу</button>
        </div>
      </form>
    </Modal>
  );
}
