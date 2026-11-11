"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useState } from "react";
import { ApprovalGate } from "@/components/approvals/ApprovalGate";
import { DraftQueue } from "@/components/approvals/DraftQueue";
import { MessageEditor } from "@/components/approvals/MessageEditor";
import { Icon } from "@/components/Icon";
import { SoonPage } from "@/components/SoonPage";
import { ConfirmDialog } from "@/components/Modal";
import { useToast } from "@/components/Toast";
import { Async, EmptyState, LoadingSkeleton, Notice, PageHeader, Panel, ScoreBadge } from "@/components/ui";
import { ApiError, getApi } from "@/lib/api";
import { useDocumentTitle, useQuery } from "@/lib/hooks";

const CONSENT_LABEL: Record<string, string> = { verified: "подтверждено", unknown: "не подтверждено", denied: "отказ", withdrawn: "отозвано", expired: "истекло" };

function Approvals() {
  useDocumentTitle("Согласование");
  const router = useRouter();
  const toast = useToast();
  const params = useSearchParams();
  const drafts = useQuery((a) => a.drafts.list());
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<null | "approve" | "reject">(null);
  const onDirty = useCallback((v: boolean) => setDirty(v), []);

  const list = drafts.data ?? [];
  const wanted = params.get("draft");
  const draft = list.find((d) => d.id === wanted) ?? list[0] ?? null;
  const preview = useQuery(async (a) => (draft ? a.outbox.preview(draft.id) : null), [draft?.id]);
  const company = useQuery(async (a) => (draft ? a.companies.get(draft.companyId) : null), [draft?.companyId]);

  const select = (id: string) => router.replace(`/approvals?draft=${id}`);
  const next = () => { if (draft && list.length > 1) select(list[(list.findIndex((d) => d.id === draft.id) + 1) % list.length]!.id); };

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    try { await fn(); }
    catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.code === "VERSION_CONFLICT") { toast(e.message, "error"); drafts.reload(); }
      else toast(e instanceof ApiError ? e.message : "Не удалось выполнить действие", "error");
    } finally { setBusy(false); setDialog(null); }
  }

  const facts = draft && company.data ? company.data.facts.filter((f) => draft.factIds.includes(f.id)) : [];
  const steps = draft && preview.data ? [true, draft.version > 1 || draft.status === "approved", preview.data.ownerApproved, preview.data.canSend] : [true, false, false, false];
  const stepLabels = ["Создан", "Проверен / изменён", "Текст согласован", "Отправка разрешена"];
  const consent = preview.data ? CONSENT_LABEL[preview.data.consentState] : "";

  return (
    <>
      <PageHeader eyebrow="КАЧЕСТВО И КОММУНИКАЦИИ" title="Согласование" subtitle="Черновик готовит шаблон или AI. Согласование текста — это ваше решение; право отправки проверяется отдельно."
        actions={<button className="btn" onClick={next} disabled={list.length < 2}><Icon name="arrow" /> Следующая компания</button>} />
      <Async q={drafts} rows={6}>
        {() => !draft ? (
          <div className="panel"><EmptyState level={2} icon="check" title="Очередь согласования пуста" text="Создайте черновик из карточки компании в базе — он появится здесь." action={<Link className="btn" href="/companies"><Icon name="building" /> Открыть базу компаний</Link>} /></div>
        ) : (
          <>
            <ol className="steps" aria-label="Этапы согласования" style={{ listStyle: "none", padding: 0 }}>
              {stepLabels.map((l, i) => <li key={l} className={steps[i] ? "done" : ""} style={{ flex: 1, height: 4, borderRadius: 10, background: steps[i] ? "#277a60" : "#e1e8e3" }}><span className="sr-only">{l}: {steps[i] ? "выполнено" : "не выполнено"}</span></li>)}
            </ol>
            <div className="grid-detail">
              <div className="stack">
                <Panel title="Очередь" subtitle={`Черновиков: ${list.length}`}><div className="panel-body"><DraftQueue drafts={list} selectedId={draft.id} onSelect={select} /></div></Panel>
                <Panel title="Персональное предложение" subtitle={`Черновик · ${draft.companyName}`} action={<ScoreBadge score={draft.score} />}>
                  <MessageEditor key={`${draft.id}:${draft.version}`} draft={draft} busy={busy} onDirty={onDirty}
                    onSave={(p) => run(async () => { await getApi().drafts.update(draft.id, p, draft.version); toast("Черновик сохранён"); })} />
                </Panel>
              </div>
              <div className="stack">
                <Panel title="Право отправки" subtitle="Проверяет сервер, не интерфейс">
                  <Async q={preview} rows={4}>
                    {(p) => p && (
                      <ApprovalGate draft={draft} preview={p} dirty={dirty} busy={busy} onApprove={() => setDialog("approve")} onReject={() => setDialog("reject")}
                        onSend={() => run(async () => { await getApi().outbox.send(draft.id); toast("Демо: отправка поставлена в очередь, реальное сообщение не отправлено"); })} />
                    )}
                  </Async>
                </Panel>
                <Panel title="Карточка компании" subtitle="Факты, на которые опирается текст" action={<Link className="link-btn" href={`/companies/${draft.companyId}`} aria-label={`Открыть карточку: ${draft.companyName}`}>Открыть <Icon name="arrow" /></Link>}>
                  <div className="panel-body">
                    <h3 style={{ fontSize: "0.9375rem" }}>{draft.companyName}</h3>
                    <p className="muted small" style={{ margin: "4px 0 12px" }}>{draft.city}</p>
                    {company.loading && !company.data ? <LoadingSkeleton rows={2} /> : facts.length === 0 ? <p className="muted">К тексту не привязано подтверждённых фактов.</p> : (
                      <ul style={{ paddingLeft: 18, margin: 0, display: "flex", flexDirection: "column", gap: 10 }}>
                        {facts.map((f) => (
                          <li key={f.id}>{f.text}
                            {f.evidenceUrl && <span className="small muted" style={{ display: "block" }}>Источник: {f.evidenceUrl}{f.evidenceExcerpt && ` — «${f.evidenceExcerpt}»`}</span>}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </Panel>
              </div>
            </div>
            {dialog === "approve" && (
              <ConfirmDialog title="Согласовать текст?" confirmLabel="Согласовать текст" busy={busy} onCancel={() => setDialog(null)}
                onConfirm={() => run(async () => { await getApi().drafts.approve(draft.id, draft.version); toast("Текст согласован. Право отправки проверяется отдельно."); })}
                text={<><p>Вы согласуете <strong>только текст</strong> версии {draft.version}. Это не заменяет согласие получателя на рекламное сообщение.</p><Notice tone={preview.data?.consentState === "verified" ? "ok" : "warn"}>Согласие адресата: {consent || "проверяется"}.</Notice></>} />
            )}
            {dialog === "reject" && (
              <ConfirmDialog title="Отклонить черновик?" danger confirmLabel="Отклонить" busy={busy} onCancel={() => setDialog(null)}
                onConfirm={() => run(async () => { await getApi().drafts.reject(draft.id); toast("Черновик отклонён"); router.replace("/approvals"); })}
                text={<p>Черновик для «{draft.companyName}» будет убран из очереди. Новый можно создать из карточки компании.</p>} />
            )}
          </>
        )}
      </Async>
    </>
  );
}

export default function ApprovalsPage() {
  if (process.env.NEXT_PUBLIC_DATA_MODE === "live") {
    return <SoonPage eyebrow="КАЧЕСТВО И КОММУНИКАЦИИ" title="Согласование" subtitle="Здесь будет очередь черновиков и согласование текста перед отправкой." icon="check"
      text="Черновики и право отправки ещё не подключены к серверу, поэтому очередь согласования пока недоступна. Отправка сообщений выключена." />;
  }
  return <Suspense fallback={<LoadingSkeleton rows={6} />}><Approvals /></Suspense>;
}

