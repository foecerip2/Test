import { Panel } from "../ui";
import m from "./analytics.module.css";

export function Funnel({ steps, demo, title = "Воронка", subtitle }: { steps: { label: string; count: number }[]; demo: boolean; title?: string; subtitle?: string }) {
  const max = Math.max(1, ...steps.map((s) => s.count));
  return (
    <Panel title={title} subtitle={subtitle ?? (demo && process.env.NEXT_PUBLIC_DATA_MODE !== "live" ? "Демо: считается по демонстрационным данным" : "Количество компаний на каждом шаге")}>
      <ul className={m.funnel}>
        {steps.map((s) => (
          <li key={s.label} className={m.frow}>
            <span>{s.label}</span>
            <span className={m.track} aria-hidden="true"><span className={m.fill} style={{ width: `${(s.count / max) * 100}%` }} /></span>
            <span className={m.num}>{s.count}</span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
