"use client";
import Link from "next/link";
import { Icon } from "@/components/Icon";
import { CompanyTable } from "@/components/companies/CompanyTable";
import { ActivityFeed, EmptyState, ErrorState, LoadingSkeleton, MetricCard, PageHeader, Panel } from "@/components/ui";
import { fmtDay, fmtRel, useDocumentTitle, useQuery } from "@/lib/hooks";

export default function OverviewPage() {
  useDocumentTitle("Обзор");
  const q = useQuery((a) => a.summary());
  const st = useQuery((a) => a.settings.get());
  const threshold = st.data?.scoreThreshold ?? 75;

  const header = (
    <PageHeader eyebrow={fmtDay(new Date().toISOString()).toUpperCase()} title="Рабочее пространство" subtitle="Ваша система поиска, квалификации и сопровождения компаний."
      actions={<Link href="/discovery" className="btn btn-primary"><Icon name="search" /> Новый поиск</Link>} />
  );

  if (q.loading && !q.data) return <>{header}<LoadingSkeleton rows={6} /></>;
  if (q.error && !q.data) return <>{header}<ErrorState level={2} error={q.error} onRetry={q.reload} /></>;
  const s = q.data!;

  if (s.companiesTotal === 0) {
    return (
      <>{header}
        <Panel>
          <EmptyState level={2} icon="building" title="В базе пока нет компаний" text="Загрузите CSV со списком компаний или создайте поисковую кампанию. Метрики и приоритеты появятся после первых данных."
            action={<Link href="/discovery" className="btn btn-primary"><Icon name="download" /> Импортировать CSV</Link>} />
        </Panel>
      </>
    );
  }

  return (
    <>
      {header}
      <div className="metric-grid">
        <MetricCard label="Компании в базе" value={s.companiesTotal} foot={`+${s.companiesWeek} за 7 дней`} icon="building" />
        <MetricCard label="Подходят под продукт" value={s.suitable} foot={`Оценка от ${threshold} баллов`} icon="radar" />
        <MetricCard label="Ожидают решения" value={s.awaitingApproval} foot="Черновики на согласовании" icon="clock" />
        <MetricCard label="Заинтересованные" value={s.interested} foot="По классификации ответов" icon="chat" />
      </div>
      <div className="grid-main">
        <Panel title="Приоритетные компании" subtitle="Лучшая оценка среди активных" action={<Link href="/companies" className="link-btn">Вся база <Icon name="arrow" /></Link>}>
          {s.topCompanies.length ? <CompanyTable items={s.topCompanies} caption="Приоритетные компании" threshold={threshold} /> : <EmptyState title="Нет активных компаний" />}
        </Panel>
        <Panel title="Последние события" subtitle="Журнал активности" action={<Link href="/inbox" className="link-btn">Диалоги <Icon name="arrow" /></Link>}>
          <ActivityFeed items={s.recent.map((e) => ({ id: e.id, icon: e.icon, title: e.title, text: e.text || "—", time: fmtRel(e.at), href: e.companyId ? `/companies/${e.companyId}` : undefined }))} />
        </Panel>
      </div>
      {s.awaitingApproval > 0 && (
        <div className="callout">
          <div>
            <h2 style={{ fontSize: "1rem", marginBottom: 6 }}>{s.awaitingApproval} {s.awaitingApproval === 1 ? "черновик ждёт" : "черновиков ждут"} вашего решения</h2>
            <p>Проверьте текст предложения и статус согласия адресата. Одобрение текста не даёт права отправки.</p>
          </div>
          <Link href="/approvals" className="btn">Перейти к согласованию <Icon name="arrow" /></Link>
        </div>
      )}
    </>
  );
}
