"use client";
import { useEffect, useRef, useState } from "react";
import { ConversationList } from "@/components/inbox/ConversationList";
import { ConversationThread } from "@/components/inbox/ConversationThread";
import { Icon } from "@/components/Icon";
import { ConfirmDialog } from "@/components/Modal";
import { TaskDialog } from "@/components/tasks/TaskDialog";
import { useToast } from "@/components/Toast";
import { Async, EmptyState, ErrorState, LoadingSkeleton, PageHeader, Panel } from "@/components/ui";
import { ApiError, getApi, type ConversationStage } from "@/lib/api";
import { useDocumentTitle, useQuery } from "@/lib/hooks";
import s from "./inbox.module.css";

export default function InboxPage() {
  useDocumentTitle("Диалоги");
  const toast = useToast();
  const convs = useQuery((a) => a.conversations.list());
  const [selected, setSelected] = useState<string | null>(null);
  const [showThread, setShowThread] = useState(false);
  const [task, setTask] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);

  const list = convs.data ?? [];
  const conv = list.find((c) => c.id === selected) ?? list[0] ?? null;
  const msgs = useQuery(async (a) => (conv ? a.conversations.messages(conv.id) : []), [conv?.id]);

  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 701px)").matches;
    if (conv?.unread && (showThread || desktop)) getApi().conversations.markRead(conv.id);
  }, [conv?.id, conv?.unread, showThread]);

  const open = (id: string) => { setSelected(id); setShowThread(true); setTimeout(() => heading.current?.focus(), 0); };
  async function classify(label: ConversationStage) {
    if (!conv) return;
    try { await getApi().conversations.classify(conv.id, label); toast(label === "unsubscribe" ? "Адрес добавлен в список подавления" : "Класс ответа обновлён"); }
    catch (e) { toast(e instanceof ApiError ? e.message : "Не удалось изменить класс", "error"); }
  }

  return (
    <>
      <PageHeader eyebrow="ДИАЛОГИ / CRM" title="Центр сообщений" subtitle="Ответы из подключённых каналов, классификация и следующий шаг."
        actions={<button className="btn" onClick={() => setTask(true)}><Icon name="plus" /> Создать задачу</button>} />
      <Panel>
        {convs.loading && !convs.data ? <LoadingSkeleton rows={6} /> : convs.error && !convs.data ? <ErrorState error={convs.error} onRetry={convs.reload} /> : !conv ? (
          <EmptyState level={2} icon="chat" title="Диалогов пока нет" text="Ответы появятся здесь после подключения канала и первых разрешённых обращений." />
        ) : (
          <div className={s.split} data-view={showThread ? "thread" : "list"}>
            <div className={s.list}><ConversationList items={list} selectedId={conv.id} onSelect={open} /></div>
            <div className={s.thread}>
              <Async q={msgs} rows={4}>
                {(m) => <ConversationThread ref={heading} conv={conv} messages={m} key={conv.id} onBack={() => { setShowThread(false); setTimeout(() => document.querySelector<HTMLElement>(`[data-conv="${conv.id}"]`)?.focus(), 0); }}
                  onClassify={(l) => (l === "unsubscribe" ? setConfirm(true) : classify(l))} onTask={() => setTask(true)} />}
              </Async>
            </div>
          </div>
        )}
      </Panel>
      {task && <TaskDialog companyId={conv?.companyId ?? null} onClose={() => setTask(false)} onCreated={() => toast("Задача создана")} />}
      {confirm && conv && (
        <ConfirmDialog title="Отметить как отписку?" danger confirmLabel="Отметить отписку" onCancel={() => setConfirm(false)}
          onConfirm={async () => { setConfirm(false); await classify("unsubscribe"); }}
          text={<p>Адрес «{conv.companyName}» будет навсегда добавлен в список подавления, а согласие помечено отозванным. Действие необратимо без нового законного основания.</p>} />
      )}
    </>
  );
}
