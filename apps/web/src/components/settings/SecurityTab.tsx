"use client";
import { useState } from "react";
import { ConfirmDialog } from "../Modal";
import { useToast } from "../Toast";
import { Async, Field, Notice, Panel, Switch } from "../ui";
import { ApiError, getApi, type Settings } from "@/lib/api";
import { useQuery } from "@/lib/hooks";

function Body({ s }: { s: Settings }) {
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const [th, setTh] = useState(String(s.scoreThreshold));
  const [ret, setRet] = useState(String(s.retentionDays));
  const [errs, setErrs] = useState<{ th?: string; ret?: string }>({});
  const [busy, setBusy] = useState(false);

  async function patch(p: Partial<Settings>, ok: string) {
    setBusy(true);
    try { await getApi().settings.patch(p); toast(ok); }
    catch (x) { toast(x instanceof ApiError ? x.message : "Не удалось сохранить", "error"); }
    finally { setBusy(false); }
  }
  async function save(e: React.FormEvent) {
    e.preventDefault();
    const t = Number(th), r = Number(ret), er: typeof errs = {};
    if (!Number.isFinite(t) || !Number.isInteger(t) || t < 0 || t > 100) er.th = "Порог — целое число от 0 до 100";
    if (!Number.isInteger(r) || r < 1 || r > 3650) er.ret = "Срок — от 1 до 3650 дней";
    setErrs(er);
    if (Object.keys(er).length) return;
    await patch({ scoreThreshold: t, retentionDays: r }, "Настройки сохранены");
  }

  return (
    <div className="stack">
      <Panel title="Отправка" subtitle="Режим по умолчанию — запрещено" pad>
        <Switch id="stop" checked={s.emergencyStopSend} label="Аварийный стоп отправки" disabled={busy}
          onChange={(v) => (v ? patch({ emergencyStopSend: true }, "Отправка остановлена") : setConfirm(true))} />
        <p className="field-hint">При включённом стопе ни одно сообщение не уйдёт, даже согласованное и с согласием адресата. Серверная проверка прав — единственный арбитр: интерфейс не может её обойти.</p>
        <div className="spacer-top"><Notice>Одобрение текста вами не заменяет согласие получателя. Без подтверждённого согласия, отсутствия блокировки и поддержки канала отправка недоступна.</Notice></div>
      </Panel>
      <Panel title="Оценка и хранение данных" pad>
        <form onSubmit={save} noValidate>
          <Field label="Порог оценки (0–100)" htmlFor="sec-th" hint="Компании ниже порога не попадают в приоритетные. Оценка и право отправки — независимые фильтры." error={errs.th}>
            <input id="sec-th" className="input" inputMode="numeric" value={th} onChange={(e) => setTh(e.target.value)} aria-invalid={!!errs.th} style={{ maxWidth: 140 }} />
          </Field>
          <Field label="Срок хранения данных, дней" htmlFor="sec-ret" hint="По истечении данные источников удаляются согласно политике." error={errs.ret}>
            <input id="sec-ret" className="input" inputMode="numeric" value={ret} onChange={(e) => setRet(e.target.value)} aria-invalid={!!errs.ret} style={{ maxWidth: 140 }} />
          </Field>
          <button className="btn btn-primary" disabled={busy}>Сохранить</button>
        </form>
      </Panel>
      {confirm && (
        <ConfirmDialog title="Снять аварийный стоп?" confirmLabel="Снять стоп" danger
          text={<>Отправка станет возможной для сообщений, у которых есть согласованный текст и подтверждённое согласие адресата. Без согласия сервер всё равно заблокирует отправку. В демо-режиме реальные сообщения не отправляются.</>}
          onCancel={() => setConfirm(false)} onConfirm={async () => { setConfirm(false); await patch({ emergencyStopSend: false }, "Аварийный стоп снят"); }} />
      )}
    </div>
  );
}

export function SecurityTab() {
  const q = useQuery((a) => a.settings.get());
  return <Async q={q} rows={5}>{(s) => <Body s={s} />}</Async>;
}
