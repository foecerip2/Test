"use client";
import { useState } from "react";
import { Icon } from "@/components/Icon";
import { CampaignForm } from "@/components/discovery/CampaignForm";
import { CampaignList } from "@/components/discovery/CampaignList";
import { JobQueue } from "@/components/discovery/JobQueue";
import { SourceList } from "@/components/discovery/SourceList";
import { ImportWizard } from "@/components/import/ImportWizard";
import { Async, ErrorState, LoadingSkeleton, PageHeader } from "@/components/ui";
import { useDocumentTitle, useQuery } from "@/lib/hooks";

export default function DiscoveryPage() {
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
