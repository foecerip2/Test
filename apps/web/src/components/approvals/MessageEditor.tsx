"use client";
import { useEffect, useState } from "react";
import { Icon } from "../Icon";
import { Field, Notice } from "../ui";
import { ChannelPicker } from "./ChannelPicker";
import type { Channel, Draft } from "@/lib/api";
import { useToast } from "../Toast";

const MAX = 4000;

export function MessageEditor({ draft, busy, onSave, onDirty }: {
  draft: Draft; busy: boolean;
  onSave: (patch: { subject: string; body: string; channel: Channel }) => Promise<void>;
  onDirty: (dirty: boolean) => void;
}) {
  const toast = useToast();
  const [subject, setSubject] = useState(draft.subject);
  const [body, setBody] = useState(draft.body);
  const [channel, setChannel] = useState<Channel>(draft.channel);
  const dirty = subject !== draft.subject || body !== draft.body || channel !== draft.channel;
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);

  async function copy() {
    try { await navigator.clipboard.writeText(body); toast("Текст скопирован"); }
    catch { toast("Не удалось скопировать — выделите текст и скопируйте вручную", "error"); }
  }

  return (
    <div className="panel-body pad-top">
      {draft.approvalStale && (
        <div style={{ marginBottom: 16 }}>
          <Notice tone="danger" icon="alert">Одобрение устарело — текст изменён после согласования. Отправка недоступна, пока вы не согласуете новую версию.</Notice>
        </div>
      )}
      <Field label="Тема письма" htmlFor="draft-subject">
        <input id="draft-subject" className="input" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} />
      </Field>
      <Field label="Текст для согласования" htmlFor="draft-body" hint={`Версия ${draft.version} · ${draft.generator === "ai" ? "AI" : "шаблон без AI"} (${draft.promptVersion})`}>
        <textarea id="draft-body" className="textarea" value={body} onChange={(e) => setBody(e.target.value)} aria-describedby="draft-count draft-body-hint" />
        <p className="small muted" id="draft-count" aria-live="polite" style={{ marginTop: 6 }}>
          {body.length} / {MAX} символов{body.length > MAX && " — слишком длинно"}
        </p>
      </Field>
      <div className="field"><ChannelPicker value={channel} onChange={setChannel} disabled={busy} /></div>
      <div className="row">
        <button className="btn" type="button" onClick={copy}><Icon name="copy" /> Копировать текст</button>
        <button className="btn" type="button" disabled={busy || !dirty || !body.trim() || body.length > MAX} onClick={() => onSave({ subject, body, channel })}>
          <Icon name="file" /> Сохранить
        </button>
        {dirty && <span className="small muted" role="status">Есть несохранённые изменения</span>}
      </div>
    </div>
  );
}
