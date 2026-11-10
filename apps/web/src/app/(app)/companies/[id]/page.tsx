"use client";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { Icon } from "@/components/Icon";
import { ConfirmDialog } from "@/components/Modal";
import { useToast } from "@/components/Toast";
import { ConsentPanel } from "@/components/companies/ConsentPanel";
import { EvidenceList } from "@/components/companies/EvidenceList";
import { ScoreBreakdown } from "@/components/companies/ScoreBreakdown";
import { TaskDialog } from "@/components/tasks/TaskDialog";
import { ActivityFeed, DemoTag, ErrorState, Field, LoadingSkeleton, ScoreBadge, StatusTag } from "@/components/ui";
import { ApiError, getApi, type CompanyDetail, type CrmStage } from "@/lib/api";
import { fmtRel, useDocumentTitle, useQuery } from "@/lib/hooks";
import s from "./company.module.css";

const STAGES: { id: CrmStage; label: string }[] = [
  { id: "new", label: "Новая" }, { id: "contacted", label: "Контакт установлен" }, { id: "replied", label: "Ответила" },
  { id: "interested", label: "Заинтересована" }, { id: "pilot", label: "Пилот" }, { id: "lost", label: "Потеряна" },
];

function NoteEditor({ id, initial }: { id: string; initial: string }) {
  const toast = useToast();
  const [v, setV] = useState(initial);
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try { await getApi().companies.setNote(id, v); toast("Заметка сохранена"); } catch { toast("Не удалось сохранить заметку", "error"); }
    setBusy(false);
  }
  return (
    <>
      <Field label="Заметка" htmlFor="note" hint="Не вносите лишние персональные данные.">
        <textarea id="note" className="textarea" style={{ minHeight: 100 }} value={v} maxLength={2000} onChange={(e) => setV(e.target.value)} />
      </Field>
      <button className="btn btn-sm" onClick={save} disabled={busy || v === initial}>Сохранить заметку</button>
    </>
  );
}

function Body({ c }: { c: CompanyDetail }) {
  const router = useRouter();
  const toast = useToast();
  const [task, setTask] = useState(false);
  const [rej, setRej] = useState(false);
  const [busy, setBusy] = useState(false);

  async function createDraft() {
    setBusy(true);
    try {
      const ch = c.contacts.some((k) => k.channel === "email") ? "email" : "phone";
      const d = await getApi().drafts.generate(c.id, ch);
      router.push(`/approvals?draft=${d.id}`);
    } catch (x) { toast(x instanceof ApiError ? x.message : "Не удалось создать черновик", "error"); setBusy(false); }
  }
  async function reject() {
    setBusy(true);
    try { await getApi().companies.reject(c.id); toast("Компания отклонена"); } catch { toast("Не удалось отклонить", "error"); }
    setBusy(false); setRej(false);
  }
  async function stage(v: CrmStage) {
    try { await getApi().companies.setStage(c.id, v); toast("Стадия обновлена"); } catch { toast("Не удалось изменить стадию", "error"); }
  }
  const closed = c.display.key === "rejected" || c.display.key === "refused";

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Карточка компании</div>
          <h1>{c.name}</h1>
          <p className="subtitle">{c.city} · {c.category}{c.website && <> · <a href={c.website} target="_blank" rel="noopener noreferrer nofollow">{c.domain}<Icon name="external" /><span className="sr-only"> (откроется в новой вкладке)</span></a></>}</p>
          <div className="row" style={{ marginTop: 10 }}>
            <ScoreBadge score={c.score} /><StatusTag status={c.display} />{c.demo && <DemoTag />}
          </div>
        </div>
        <div className="head-buttons">
          {c.draftId
            ? <Link href={`/approvals?draft=${c.draftId}`} className="btn btn-primary"><Icon name="file" /> Открыть черновик</Link>
            : <button className="btn btn-primary" onClick={createDraft} disabled={busy || closed} title={closed ? "Компания отклонена или отказалась" : undefined}><Icon name="file" /> Создать черновик</button>}
          <button className="btn" onClick={() => setTask(true)}><Icon name="clock" /> Создать задачу</button>
          <button className="btn btn-danger" onClick={() => setRej(true)} disabled={c.state === "rejected"} title={c.state === "rejected" ? "Уже отклонена" : undefined}>Отклонить</button>
        </div>
      </div>
      <div className="grid-detail">
        <div className="stack">
          <section className="panel"><div className="panel-heading"><div><h2>Основания для персонализации</h2><p>Факты с источником отделены от гипотез</p></div></div>
            <div className="panel-body"><EvidenceList facts={c.facts} /></div></section>
          <section className="panel"><div className="panel-heading"><div><h2>Контакты и согласие адресата</h2><p>Согласие проверяется отдельно от одобрения текста</p></div></div>
            <div className="panel-body"><ConsentPanel contacts={c.contacts} /></div></section>
          <section className="panel"><div className="panel-heading"><div><h2>История</h2><p>События по компании</p></div></div>
            <ActivityFeed items={c.history.map((e) => ({ id: e.id, icon: e.icon, title: e.title, text: e.text || "—", time: fmtRel(e.at) }))} /></section>
        </div>
        <div className="stack">
          <section className="panel"><div className="panel-heading"><div><h2>Оценка</h2><p>Разбор по правилам</p></div><ScoreBadge score={c.score} /></div>
            <div className="panel-body"><ScoreBreakdown reasons={c.scoreReasons} version={c.scoreVersion} /></div></section>
          <section className="panel"><div className="panel-heading"><div><h2>Работа с компанией</h2></div></div>
            <div className="panel-body">
              <Field label="Стадия воронки" htmlFor="stage">
                <select id="stage" className="select" value={c.stage} onChange={(e) => stage(e.target.value as CrmStage)}>{STAGES.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</select>
              </Field>
              <NoteEditor key={c.id} id={c.id} initial={c.note} />
              <dl className={`kv ${s.meta}`}><dt>Источник</dt><dd>{c.sourceLabel}</dd></dl>
            </div></section>
        </div>
      </div>
      {task && <TaskDialog companyId={c.id} onClose={() => setTask(false)} />}
      {rej && <ConfirmDialog title="Отклонить компанию?" danger busy={busy} confirmLabel="Отклонить" onCancel={() => setRej(false)} onConfirm={reject}
        text="Компания будет исключена из работы и не попадёт в приоритетные. Данные и история сохранятся." />}
    </>
  );
}

export default function CompanyPage() {
  const { id } = useParams<{ id: string }>();
  const q = useQuery((a) => a.companies.get(id), [id]);
  useDocumentTitle(q.data?.name ?? "Карточка компании");
  if (q.loading && !q.data) return <LoadingSkeleton rows={8} />;
  if (q.error && !q.data) return <><ErrorState level={1} error={q.error} onRetry={q.reload} /><p style={{ textAlign: "center" }}><Link href="/companies">← К базе компаний</Link></p></>;
  return <Body c={q.data!} />;
}
