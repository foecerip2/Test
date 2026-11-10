"use client";
import { Async, EmptyState, Panel } from "../ui";
import { fmtDate, useQuery } from "@/lib/hooks";

export function AuditTab() {
  const q = useQuery((a) => a.audit());
  return (
    <Panel title="Журнал аудита" subtitle="Неизменяемая история действий">
      <Async q={q} rows={5}>
        {(d) => d.length === 0 ? <EmptyState icon="file" title="Записей нет" /> : (
          <div className="table-wrap" tabIndex={0} role="region" aria-label="Журнал аудита">
            <table className="data-table">
              <caption className="sr-only">Журнал аудита, последние 100 записей</caption>
              <thead><tr><th scope="col">Время</th><th scope="col">Действие</th><th scope="col">Объект</th><th scope="col">Кто</th><th scope="col">Детали</th></tr></thead>
              <tbody>{d.slice(0, 100).map((e) => <tr key={e.id}><td>{fmtDate(e.at)}</td><td>{e.action}</td><td>{e.entity} · {e.entityId}</td><td>{e.actor}</td><td>{e.meta || "—"}</td></tr>)}</tbody>
            </table>
          </div>
        )}
      </Async>
    </Panel>
  );
}
