"use client";
import { fmtDay } from "@/lib/hooks";
import type { Fact } from "@/lib/api";
import { EmptyState } from "../ui";

function FactItem({ f }: { f: Fact }) {
  return (
    <li style={{ padding: "12px 0", borderBottom: "1px solid #f0f3ef" }}>
      <p style={{ fontWeight: 600 }}>{f.text}</p>
      {f.evidenceExcerpt && <p className="muted small" style={{ marginTop: 4 }}>Выдержка: «{f.evidenceExcerpt}»</p>}
      <p className="muted small" style={{ marginTop: 4 }}>
        {f.evidenceUrl && /^https?:\/\//i.test(f.evidenceUrl) ? <a href={f.evidenceUrl} target="_blank" rel="noopener noreferrer nofollow">Источник</a> : "Источник не указан"}
        {" · "}проверено {fmtDay(f.observedAt)}{" · "}уверенность {Math.round(f.confidence * 100)}%
      </p>
    </li>
  );
}

export function EvidenceList({ facts }: { facts: Fact[] }) {
  const confirmed = facts.filter((f) => f.kind === "confirmed");
  const hypotheses = facts.filter((f) => f.kind === "hypothesis");
  if (!facts.length) return <EmptyState title="Фактов пока нет" text="Они появятся после проверки сайта или ручного ввода." />;
  return (
    <div>
      <h3 style={{ fontSize: "0.875rem" }}>Подтверждённые факты</h3>
      {confirmed.length ? <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>{confirmed.map((f) => <FactItem key={f.id} f={f} />)}</ul>
        : <p className="muted" style={{ padding: "10px 0" }}>Подтверждённых фактов нет.</p>}
      <h3 style={{ fontSize: "0.875rem", marginTop: 18 }}>Гипотезы (требуют проверки)</h3>
      {hypotheses.length ? <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>{hypotheses.map((f) => <FactItem key={f.id} f={f} />)}</ul>
        : <p className="muted" style={{ padding: "10px 0" }}>Гипотез нет.</p>}
    </div>
  );
}
