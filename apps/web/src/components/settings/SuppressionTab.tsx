"use client";
import { Async, EmptyState, Notice, Panel } from "../ui";
import { useQuery, fmtDate } from "@/lib/hooks";

export function SuppressionTab() {
  const q = useQuery((a) => a.suppression());
  return (
    <Panel title="Список подавления" subtitle="Адреса, которым рекламные сообщения запрещены" >
      <div className="panel-body"><Notice>Запись необратима: адрес остаётся заблокированным, пока не появится новое законное основание. Удаления из этого списка нет намеренно.</Notice></div>
      <Async q={q} rows={3}>
        {(d) => d.length === 0 ? <EmptyState icon="shield" title="Список пуст" text="Сюда попадают отписки и отозванные согласия." /> : (
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th scope="col">Канал</th><th scope="col">Адрес</th><th scope="col">Причина</th><th scope="col">Дата</th></tr></thead>
              <tbody>{d.map((e) => <tr key={e.id}><td>{e.channel}</td><td>{e.endpointMasked}</td><td>{e.reason}</td><td>{fmtDate(e.createdAt)}</td></tr>)}</tbody>
            </table>
          </div>
        )}
      </Async>
    </Panel>
  );
}
