"use client";
import type { ScoreReason } from "@/lib/api";

export function ScoreBreakdown({ reasons, version }: { reasons: ScoreReason[]; version: string }) {
  return (
    <div>
      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {reasons.map((r) => (
          <li key={r.rule} style={{ padding: "10px 0", borderBottom: "1px solid #f0f3ef" }}>
            <div className="row between">
              <strong>{r.label}</strong>
              <span className={`score ${r.points === 0 ? "low" : r.points < r.max ? "mid" : ""}`}>{r.points} / {r.max}</span>
            </div>
            <progress max={r.max} value={r.points} aria-label={`${r.label}: ${r.points} из ${r.max}`} style={{ width: "100%", height: 6, marginTop: 6, accentColor: "var(--accent)" }} />
            <p className="muted small" style={{ marginTop: 4 }}>{r.note}</p>
          </li>
        ))}
      </ul>
      <p className="muted small" style={{ marginTop: 10 }}>Версия правил: {version}. Оценка и право отправки — разные проверки.</p>
    </div>
  );
}
