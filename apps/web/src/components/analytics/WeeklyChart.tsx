import { Panel } from "../ui";
import m from "./analytics.module.css";

export function WeeklyChart({ weeks, demo }: { weeks: { label: string; found: number; passed: number }[]; demo: boolean }) {
  const max = Math.max(1, ...weeks.flatMap((w) => [w.found, w.passed]));
  const summary = weeks.map((w) => `${w.label}: найдено ${w.found}, прошли порог ${w.passed}`).join("; ");
  return (
    <Panel title="Компании по неделям" subtitle={demo ? "Демо: последние 8 недель" : "Последние 8 недель"}>
      <div className={m.legend}>
        <span><i className={m.sw} style={{ background: "#7a9b8c" }} />Найдено</span>
        <span><i className={m.sw} style={{ background: "var(--accent)" }} />Прошли порог оценки</span>
      </div>
      <div className={m.chart}>
        <div className={m.bars} role="img" aria-label={`График по неделям. ${summary}`}>
          {weeks.map((w) => (
            <div key={w.label} className={m.col}>
              <span className={m.b1} style={{ height: `${(w.found / max) * 100}%` }} />
              <span className={m.b2} style={{ height: `${(w.passed / max) * 100}%` }} />
            </div>
          ))}
        </div>
        <div className={m.labels} aria-hidden="true">{weeks.map((w) => <span key={w.label}>{w.label}</span>)}</div>
      </div>
      <details className={m.alt}>
        <summary>Показать данные таблицей</summary>
        <div className="table-wrap" tabIndex={0} role="region" aria-label="Компании по неделям, таблица">
          <table className="data-table" style={{ minWidth: 320 }}>
            <caption className="sr-only">Компании по неделям</caption>
            <thead><tr><th scope="col">Неделя</th><th scope="col">Найдено</th><th scope="col">Прошли порог</th></tr></thead>
            <tbody>{weeks.map((w) => <tr key={w.label}><td>{w.label}</td><td>{w.found}</td><td>{w.passed}</td></tr>)}</tbody>
          </table>
        </div>
      </details>
    </Panel>
  );
}
