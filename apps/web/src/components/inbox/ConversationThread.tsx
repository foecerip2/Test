"use client";
import Link from "next/link";
import { forwardRef, useState } from "react";
import { Icon } from "../Icon";
import { Notice, StatusTag } from "../ui";
import { useToast } from "../Toast";
import { stageTone } from "./ConversationList";
import { STAGE_LABEL } from "@/lib/classify";
import { fmtDate } from "@/lib/hooks";
import type { Conversation, ConversationStage, Message } from "@/lib/api";

const CHOICES: ConversationStage[] = ["interested", "question", "later", "not_interested", "unsubscribe", "wrong_contact", "ambiguous"];

export const ConversationThread = forwardRef<HTMLHeadingElement, {
  conv: Conversation; messages: Message[]; onBack: () => void; onClassify: (l: ConversationStage) => void; onTask: () => void;
}>(function ConversationThread({ conv, messages, onBack, onClassify, onTask }, headingRef) {
  const toast = useToast();
  const [reply, setReply] = useState("");
  const lastIn = [...messages].reverse().find((m) => m.direction === "in");
  const cls = lastIn?.classification;
  const locked = conv.stage === "unsubscribe";
  const options = CHOICES.includes(conv.stage) ? CHOICES : [conv.stage, ...CHOICES];

  async function copy() {
    if (!reply.trim()) { toast("Сначала введите текст ответа", "error"); return; }
    try { await navigator.clipboard.writeText(reply); toast("Черновик ответа скопирован"); }
    catch { toast("Не удалось скопировать — выделите текст вручную", "error"); }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, height: "100%" }}>
      <div className="row between" style={{ padding: 18, borderBottom: "1px solid var(--border)", gap: 12 }}>
        <div>
          <button type="button" className="link-btn back-btn" onClick={onBack} style={{ minHeight: 44 }}><span style={{ transform: "rotate(180deg)", display: "inline-flex" }}><Icon name="arrow" /></span> Назад к списку</button>
          <h2 ref={headingRef} tabIndex={-1} style={{ fontSize: "1rem" }}>{conv.companyName}</h2>
          <p className="small muted" style={{ marginTop: 4 }}>Канал: {conv.channel} · <Link href={`/companies/${conv.companyId}`}>Карточка компании</Link></p>
        </div>
        <StatusTag tone={stageTone(conv.stage)}>{STAGE_LABEL[conv.stage]}</StatusTag>
      </div>
      <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14, flex: 1, background: "#fcfdfa", overflowY: "auto" }}>
        {messages.map((m) => (
          <div key={m.id} style={{ maxWidth: "82%", alignSelf: m.direction === "out" ? "flex-end" : "flex-start", borderRadius: 10, padding: "12px 14px", lineHeight: 1.65,
            background: m.direction === "out" ? "#e6f2e9" : "var(--paper)", border: m.direction === "out" ? "1px solid #cfe5d6" : "1px solid var(--border)", color: m.direction === "out" ? "#24503c" : "var(--ink)" }}>
            {m.body}
            <span className="small muted" style={{ display: "block", marginTop: 6 }}>{fmtDate(m.at)} · {m.direction === "out" ? "Исходящее" : "Входящее"}</span>
          </div>
        ))}
        {cls && (
          <Notice tone="info" icon="spark">
            Класс ответа: <strong>{STAGE_LABEL[cls.label]}</strong> · {cls.by === "manual" ? "Вручную" : `Правила, уверенность ${Math.round(cls.confidence * 100)}%`}
            {cls.by === "rules" && cls.confidence < 0.7 && " — низкая уверенность, проверьте вручную"}.
          </Notice>
        )}
        {conv.stage === "unsubscribe" && <Notice tone="danger" icon="shield">Адрес в списке подавления. Рекламные обращения заблокированы, отмена невозможна без нового законного основания.</Notice>}
      </div>
      <div style={{ borderTop: "1px solid var(--border)", padding: 16 }}>
        <div className="field" style={{ marginBottom: 14 }}>
          <label className="field-label" htmlFor="classify">Класс ответа (ручная правка)</label>
          <select id="classify" className="select" value={conv.stage} disabled={locked} aria-describedby={locked ? "classify-why" : undefined} onChange={(e) => onClassify(e.target.value as ConversationStage)}>
            {options.map((s) => <option key={s} value={s}>{STAGE_LABEL[s]}</option>)}
          </select>
          {locked && <p className="field-hint" id="classify-why">Отписку изменить нельзя — адрес остаётся в списке подавления.</p>}
        </div>
        <div className="field" style={{ marginBottom: 12 }}>
          <label className="field-label" htmlFor="reply">Черновик ответа</label>
          <textarea id="reply" className="textarea" style={{ minHeight: 90 }} value={reply} onChange={(e) => setReply(e.target.value)} disabled={locked} placeholder="Текст ответа" aria-describedby="reply-hint" />
          <p className="field-hint" id="reply-hint">Ответ отправляется вручную в канале — приложение его не отправляет.</p>
        </div>
        <div className="row">
          <button className="btn" onClick={copy} disabled={locked}><Icon name="copy" /> Копировать</button>
          <button className="btn" onClick={onTask}><Icon name="plus" /> Создать задачу</button>
        </div>
      </div>
    </div>
  );
});
