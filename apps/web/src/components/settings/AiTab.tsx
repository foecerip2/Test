"use client";
import { useState } from "react";
import { useToast } from "../Toast";
import { Async, Field, Notice, Panel } from "../ui";
import { ApiError, getApi, type Settings } from "@/lib/api";
import { useQuery } from "@/lib/hooks";

const MODES: { id: Settings["aiMode"]; label: string }[] = [
  { id: "none", label: "Без AI" }, { id: "api", label: "Через официальный API" }, { id: "manual", label: "Вручную" },
];

function Body({ s }: { s: Settings }) {
  const toast = useToast();
  const [daily, setDaily] = useState(String(s.aiDailyBudgetRub));
  const [monthly, setMonthly] = useState(String(s.aiMonthlyBudgetRub));
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function setMode(aiMode: Settings["aiMode"]) {
    try { await getApi().settings.patch({ aiMode }); toast("Режим AI сохранён"); }
    catch (x) { toast(x instanceof ApiError ? x.message : "Не удалось сохранить", "error"); }
  }
  async function saveBudget(e: React.FormEvent) {
    e.preventDefault();
    const d = Number(daily), m = Number(monthly);
    if (!Number.isFinite(d) || !Number.isFinite(m) || d < 0 || m < 0) return setErr("Бюджеты — неотрицательные числа");
    if (d > m) return setErr("Дневной бюджет не может превышать месячный");
    setErr(null); setBusy(true);
    try { await getApi().settings.patch({ aiDailyBudgetRub: d, aiMonthlyBudgetRub: m }); toast("Бюджет сохранён"); }
    catch (x) { toast(x instanceof ApiError ? x.message : "Не удалось сохранить", "error"); }
    finally { setBusy(false); }
  }

  return (
    <div className="stack">
      <Panel title="Режим AI" subtitle="AI — вспомогательный инструмент. Без него поиск, карточки, шаблоны и CRM работают полностью." pad>
        <div className="choice-row" role="radiogroup" aria-label="Режим AI">
          {MODES.map((m) => <button key={m.id} role="radio" aria-checked={s.aiMode === m.id} className="choice" onClick={() => setMode(m.id)}>{m.label}</button>)}
        </div>
        <div className="spacer-top">
          <Notice tone="info" icon="lock">Вход через подписку на обычный чат (ChatGPT, Claude) недоступен: подписка не даёт API-доступа. Подключение появится, только когда провайдер официально поддержит OAuth для сторонних приложений.</Notice>
        </div>
      </Panel>

      {s.aiMode === "api" && (
        <Panel title="Официальный API" subtitle="Доступно в Фазе 4. Сейчас параметры подключения только описаны." pad>
          <Field label="Base URL" htmlFor="ai-url" hint="Задаётся в конфигурации сервера."><input id="ai-url" className="input" disabled placeholder="https://…" /></Field>
          <Field label="Модель" htmlFor="ai-model" hint="Задаётся в конфигурации сервера."><input id="ai-model" className="input" disabled /></Field>
          <Field label="API-ключ" htmlFor="ai-key" hint="Ключ вносится в секреты сервера и никогда не вводится в браузер."><input id="ai-key" className="input" disabled placeholder="Не отображается" /></Field>
          <form onSubmit={saveBudget} noValidate>
            <div className="row" style={{ alignItems: "flex-start" }}>
              <Field label="Бюджет в день, ₽" htmlFor="ai-day"><input id="ai-day" className="input" inputMode="decimal" value={daily} onChange={(e) => setDaily(e.target.value)} aria-invalid={!!err} style={{ maxWidth: 160 }} /></Field>
              <Field label="Бюджет в месяц, ₽" htmlFor="ai-month" error={err}><input id="ai-month" className="input" inputMode="decimal" value={monthly} onChange={(e) => setMonthly(e.target.value)} aria-invalid={!!err} style={{ maxWidth: 160 }} /></Field>
            </div>
            <p className="field-hint" style={{ marginBottom: 12 }}>После достижения лимита AI останавливается, система переходит на шаблоны.</p>
            <button className="btn btn-primary" disabled={busy}>Сохранить бюджет</button>
          </form>
        </Panel>
      )}

      {s.aiMode === "manual" && (
        <Panel title="Ручной режим" subtitle="Использование имеющейся подписки без автоматизации" pad>
          <p className="muted">Система формирует обезличенное AI-задание (экспорт), вы выполняете его в своём чате и вставляете результат обратно (импорт). Результат проходит ту же проверку и ручное согласование. Появится в Фазе 4.</p>
        </Panel>
      )}

      <Panel title="Расходы AI" subtitle="Фактические значения из учёта" pad>
        <dl className="kv">
          <dt>Сегодня</dt><dd>{s.aiSpentTodayRub.toFixed(2)} ₽ из {s.aiDailyBudgetRub} ₽</dd>
          <dt>За месяц</dt><dd>{s.aiSpentMonthRub.toFixed(2)} ₽ из {s.aiMonthlyBudgetRub} ₽</dd>
        </dl>
        {s.aiMode === "none" && <p className="field-hint">Режим «Без AI»: расходов нет.</p>}
      </Panel>
    </div>
  );
}

export function AiTab() {
  const q = useQuery((a) => a.settings.get());
  return <Async q={q} rows={5}>{(s) => <Body s={s} />}</Async>;
}
