"use client";
import { Funnel } from "@/components/analytics/Funnel";
import { WeeklyChart } from "@/components/analytics/WeeklyChart";
import { ActivityFeed, Async, ComingSoon, EmptyState, MetricCard, PageHeader, Panel } from "@/components/ui";
import type { Summary } from "@/lib/api";
import { useDocumentTitle, useQuery } from "@/lib/hooks";

const STAGE_LABEL: [keyof NonNullable<Summary["byStage"]>, string][] = [
  ["new", "Новые"], ["contacted", "Контакт"], ["replied", "Ответили"], ["interested", "Заинтересованы"], ["pilot", "Пилот"], ["lost", "Отказ"],
];

export default function AnalyticsPage() {
  useDocumentTitle("Аналитика");
  const q = useQuery((a) => a.summary());
  const demo = process.env.NEXT_PUBLIC_DATA_MODE !== "live";
  return (
    <>
      <PageHeader eyebrow="Метрики / результаты" title="Аналитика"
        subtitle="Только реальные события из базы. Ничего не подставляется для красоты."
        actions={demo ? <span className="tag demo">Демо</span> : undefined} />
      <Async q={q} rows={6}>
        {(s) => s.companiesTotal === 0 ? (
          <Panel><EmptyState level={2} icon="chart" title="Данных для аналитики пока нет" text={demo ? "Импортируйте компании или запустите кампанию — метрики появятся автоматически." : "Загрузите CSV с компаниями — счётчики по стадиям появятся автоматически."} /></Panel>
        ) : demo ? (
          <>
            <div className="metric-grid">
              <MetricCard label="Компаний в базе" value={s.companiesTotal} foot={`+${s.companiesWeek} за 7 дней`} icon="building" />
              <MetricCard label="Выше порога оценки" value={s.suitable} foot={`из ${s.companiesTotal}`} icon="radar" />
              <MetricCard label="Ждут согласования" value={s.awaitingApproval ?? 0} foot="Черновики на проверке" icon="clock" />
              <MetricCard label="Заинтересованы" value={s.interested ?? 0} foot="По классификации ответов" icon="chat" />
            </div>
            <div className="grid-2">
              <div className="stack"><WeeklyChart weeks={s.weekly ?? []} demo={demo} /><Funnel steps={s.funnel ?? []} demo={demo} /></div>
              <Panel title="Качество базы" subtitle="Контроль входных данных">
                <ActivityFeed items={[
                  { id: "q1", icon: "shield", title: "Подтверждены источником", text: "Доля компаний с фактом, у которого есть ссылка и выдержка", time: `${s.quality?.withEvidencePct ?? 0}%` },
                  { id: "q2", icon: "check", title: "Помечены как дубликаты", text: "Кандидаты на ручную проверку", time: String(s.quality?.duplicatesMarked ?? 0) },
                  { id: "q3", icon: "chat", title: "Отказы", text: "Исключаются из повторных обращений", time: String(s.quality?.refusals ?? 0) },
                  { id: "q4", icon: "lock", title: "В списке подавления", text: "Рекламные сообщения заблокированы", time: String(s.quality?.suppressed ?? 0) },
                ]} />
              </Panel>
            </div>
          </>
        ) : (
          <>
            <div className="metric-grid">
              <MetricCard label="Компаний в базе" value={s.companiesTotal} foot={`+${s.companiesWeek} за 7 дней`} icon="building" />
              <MetricCard label="Выше порога оценки" value={s.suitable} foot={`Порог: ${s.scoreThreshold ?? 75} баллов`} icon="radar" />
            </div>
            <div className="grid-2">
              <div className="stack">
                <Funnel title="Компании по стадиям" subtitle="Сколько компаний сейчас на каждой стадии воронки" demo={false}
                  steps={STAGE_LABEL.map(([k, label]) => ({ label, count: s.byStage?.[k] ?? 0 }))} />
              </div>
              <div className="stack">
                <Panel title="Динамика, воронка продаж и качество базы" subtitle="Скоро">
                  <ComingSoon boxed={false} level={3} title="Эти показатели появятся в следующем обновлении" text="Недельный график, сквозная воронка и контроль качества базы ещё не подключены к серверу." />
                </Panel>
              </div>
            </div>
          </>
        )}
      </Async>
    </>
  );
}
