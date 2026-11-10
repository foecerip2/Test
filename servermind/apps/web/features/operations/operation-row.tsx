import Link from "next/link";
import { formatDateTimeUtc, relativeTime } from "@/lib/format";
import type { Operation } from "@/lib/types";
import { JobStatusBadge, RiskBadge, SourceBadge } from "@/features/status";

/** Список операций: таблица на desktop, карточки на mobile (без горизонтального скролла). */
export function OperationList({ items, compact }: { items: Operation[]; compact?: boolean }) {
  const href = (o: Operation) => (o.status === "waiting_approval" && o.planId ? `/operations/${o.id}/approve` : `/operations/${o.id}`);
  return (
    <>
      <div className={compact ? "hidden" : "hidden overflow-hidden rounded-card border border-stroke md:block"}>
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Список операций</caption>
          <thead className="border-b border-stroke bg-elevated text-xs text-text-muted">
            <tr>
              <th scope="col" className="px-4 py-3 font-medium">Операция</th>
              <th scope="col" className="px-4 py-3 font-medium">Сервер</th>
              <th scope="col" className="px-4 py-3 font-medium">Статус</th>
              <th scope="col" className="px-4 py-3 font-medium">Риск</th>
              <th scope="col" className="px-4 py-3 font-medium">Автор</th>
              <th scope="col" className="px-4 py-3 font-medium">Время</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stroke bg-surface">
            {items.map((o) => (
              <tr key={o.id} className="transition-colors hover:bg-elevated">
                <td className="max-w-[320px] px-4 py-3">
                  <Link href={href(o)} className="flex items-center gap-2 font-medium hover:text-primary">
                    <span className="truncate">{o.title}</span><SourceBadge source={o.source} />
                  </Link>
                </td>
                <td className="px-4 py-3 text-text-secondary">{o.serverName}</td>
                <td className="px-4 py-3"><JobStatusBadge status={o.status} /></td>
                <td className="px-4 py-3"><RiskBadge risk={o.risk} /></td>
                <td className="px-4 py-3 text-text-secondary">{o.actor}</td>
                <td className="tabular whitespace-nowrap px-4 py-3 text-text-secondary" title={formatDateTimeUtc(o.createdAt)}>{relativeTime(o.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className={compact ? "divide-y divide-stroke" : "space-y-3 md:hidden"} aria-label="Операции">
        {items.map((o) => (
          <li key={o.id}>
            <Link
              href={href(o)}
              className={compact ? "flex min-h-14 flex-col gap-1.5 py-3 hover:text-primary" : "block rounded-card border border-stroke bg-surface p-4 transition-colors hover:bg-elevated"}
            >
              <span className="flex items-start justify-between gap-3">
                <span className="min-w-0 font-medium">{o.title}</span>
                <JobStatusBadge status={o.status} />
              </span>
              <span className="text-xs text-text-muted">{o.serverName} · {o.actor} · {relativeTime(o.createdAt)}</span>
              {!compact && <span className="mt-2 flex gap-2"><RiskBadge risk={o.risk} /><SourceBadge source={o.source} /></span>}
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
