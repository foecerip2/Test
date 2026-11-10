"use client";
import { Funnel } from "@/components/analytics/Funnel";
import { WeeklyChart } from "@/components/analytics/WeeklyChart";
import { ActivityFeed, Async, DemoTag, EmptyState, MetricCard, PageHeader, Panel } from "@/components/ui";
import { getApi } from "@/lib/api";
import { useDocumentTitle, useQuery } from "@/lib/hooks";

export default function AnalyticsPage() {
  useDocumentTitle("Аналитика");
  const q = useQuery((a) => a.summary());
  const demo = getApi().mode === "mock";
  return (
    <>
      <PageHeader eyebrow="Метрики / результаты" title="Аналитика"
        subtitle="Только реальные события из базы. Ничего не подставляется для красоты."
        actions={demo ? <DemoTag /> : undefined} />
      <Async q={q} rows={6}>
        {(s) => s.companiesTotal === 0 ? (
          <Panel><EmptyState level={2} icon="chart" title="Данных для аналитики пока нет" text="Импортируйте компании или запустите кампанию — метрики появятся автоматически." /></Panel>
        ) : (
          <>
            <div className="metric-grid">
              <MetricCard label="Компаний в базе" value={s.companiesTotal} foot={`+${s.companiesWeek} за 7 дней`} icon="building" />
              <MetricCard label="Выше порога оценки" value={s.suitable} foot={`из ${s.companiesTotal}`} icon="radar" />
              <MetricCard label="Ждут согласования" value={s.awaitingApproval} foot="Черновики на проверке" icon="clock" />
              <MetricCard label="Заинтересованы" value={s.interested} foot="По классификации ответов" icon="chat" />
            </div>
            <div className="grid-2">
              <div className="stack"><WeeklyChart weeks={s.weekly} demo={demo} /><Funnel steps={s.funnel} demo={demo} /></div>
              <Panel title="Качество базы" subtitle="Контроль входных данных">
                <ActivityFeed items={[
                  { id: "q1", icon: "shield", title: "Подтверждены источником", text: "Доля компаний с фактом, у которого есть ссылка и выдержка", time: `${s.quality.withEvidencePct}%` },
                  { id: "q2", icon: "check", title: "Помечены как дубликаты", text: "Кандидаты на ручную проверку", time: String(s.quality.duplicatesMarked) },
                  { id: "q3", icon: "chat", title: "Отказы", text: "Исключаются из повторных обращений", time: String(s.quality.refusals) },
                  { id: "q4", icon: "lock", title: "В списке подавления", text: "Рекламные сообщения заблокированы", time: String(s.quality.suppressed) },
                ]} />
              </Panel>
            </div>
          </>
        )}
      </Async>
    </>
  );
}
