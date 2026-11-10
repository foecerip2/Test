import { Panel, StatusTag } from "../ui";
import type { SourceConfig } from "@/lib/api";

export function SourceList({ sources }: { sources: SourceConfig[] }) {
  return (
    <Panel title="Источники и лицензии" subtitle="Каждый источник — только по проверенной лицензии и правилам использования">
      <ul className="feed">
        {sources.map((s) => (
          <li key={s.id} className="feed-item" style={{ flexWrap: "wrap" }}>
            <div className="feed-text" style={{ flex: 1, minWidth: 200 }}>
              <strong>{s.name}</strong>
              <p>Лицензия: {s.licensePolicy}</p>
              {s.disabledReason && <p>{s.disabledReason}</p>}
            </div>
            <StatusTag tone={s.enabled ? "green" : "neutral"}>{s.enabled ? "Включён" : "Отключён"}</StatusTag>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
