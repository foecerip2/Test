"use client";
import { useState } from "react";
import { Icon } from "@/components/Icon";
import { CampaignForm } from "@/components/discovery/CampaignForm";
import { CampaignList } from "@/components/discovery/CampaignList";
import { JobQueue } from "@/components/discovery/JobQueue";
import { SourceList } from "@/components/discovery/SourceList";
import { ImportWizard } from "@/components/import/ImportWizard";
import { Async, ComingSoon, ErrorState, LoadingSkeleton, PageHeader, Panel } from "@/components/ui";
import { useDocumentTitle, useQuery } from "@/lib/hooks";

export default function DiscoveryPage() {
  if (process.env.NEXT_PUBLIC_DATA_MODE === "live") return <LiveDiscovery />;
  return <MockDiscovery />;
}

/** Рабочий режим: живой только импорт CSV; кампании, очередь задач и источники помечены «скоро». */
function LiveDiscovery() {
  useDocumentTitle("Поиск компаний");
  const [wizard, setWizard] = useState(false);
  return (
    <>
      <PageHeader eyebrow="Источники и данные" title="Поиск компаний"
        subtitle="Пока компании попадают в базу из вашего CSV: каждая строка проходит проверку и дедупликацию."
        actions={<button className="btn btn-primary" onClick={() => setWizard(true)}><Icon name="upload" /> Импорт CSV</button>} />
      <div className="grid-2">
        <div className="stack">
          <Panel title="Импорт из CSV" subtitle="Работает сейчас">
            <div className="panel-body">
              <p style={{ marginTop: 0 }}>Загрузите файл с колонками «название» и «город» (категория, сайт и ИНН — по желанию). Перед записью вы увидите предпросмотр: ошибки и дубли будут отмечены, а сервер ещё раз проверит файл при импорте.</p>
              <button className="btn btn-primary" onClick={() => setWizard(true)}><Icon name="upload" /> Выбрать CSV</button>
            </div>
          </Panel>
          <Panel title="Кампании поиска" subtitle="Скоро"><ComingSoon boxed={false} level={3} title="Кампании появятся в следующем обновлении" text="Автоматический поиск по регионам и категориям ещё не подключён к серверу." /></Panel>
        </div>
        <div className="stack">
          <Panel title="Очередь задач" subtitle="Скоро"><ComingSoon boxed={false} level={3} title="Очередь появится в следующем обновлении" text="Фоновые задачи (проверка сайтов, оценка) ещё не подключены к серверу." /></Panel>
          <Panel title="Источники данных" subtitle="Скоро"><ComingSoon boxed={false} level={3} title="Источники появятся в следующем обновлении" text="Подключение каталогов и карт — после проверки лицензий." /></Panel>
        </div>
      </div>
      {wizard && <ImportWizard onClose={() => setWizard(false)} />}
    </>
  );
}

function MockDiscovery() {
  useDocumentTitle("Поиск компаний");
  const [wizard, setWizard] = useState(false);
  const sources = useQuery((a) => a.sources());
  const campaigns = useQuery((a) => a.campaigns.list());
  const jobs = useQuery((a) => a.jobs.list());

  return (
    <>
      <PageHeader eyebrow="Источники и данные" title="Поиск компаний"
        subtitle="География — вся Россия, но итеративно: город за городом. Каждая компания проходит проверку источника и дедупликацию."
        actions={<button className="btn btn-primary" onClick={() => setWizard(true)}><Icon name="upload" /> Импорт CSV / XLSX</button>} />
      <div className="grid-2">
        <div className="stack">
          {sources.loading && !sources.data ? <LoadingSkeleton rows={6} /> : sources.error && !sources.data ? <ErrorState error={sources.error} onRetry={sources.reload} /> : sources.data && <CampaignForm sources={sources.data} />}
          <Async q={campaigns} rows={3}>{(d) => <CampaignList campaigns={d} />}</Async>
        </div>
        <div className="stack">
          <Async q={jobs} rows={4}>{(d) => <JobQueue jobs={d} />}</Async>
          <Async q={sources} rows={3}>{(d) => <SourceList sources={d} />}</Async>
        </div>
      </div>
      {wizard && <ImportWizard onClose={() => setWizard(false)} />}
    </>
  );
}
