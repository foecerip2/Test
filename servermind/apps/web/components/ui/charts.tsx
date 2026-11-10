"use client";

import { useId, useMemo, useState, type PointerEvent } from "react";
import type { MetricSample } from "@/lib/types";
import { formatDateTimeUtc } from "@/lib/format";

const W = 600;
const H = 160;

function path(values: number[], max = 100): { line: string; area: string } {
  if (values.length < 2) return { line: "", area: "" };
  const step = W / (values.length - 1);
  const pts = values.map((v, i) => [i * step, H - (Math.max(0, Math.min(max, v)) / max) * H] as const);
  const line = pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  return { line, area: `${line} L${W},${H} L0,${H} Z` };
}

/** Мини-график для карточек. Рисуется только по реальным значениям; <2 точек → подпись «нет данных». */
export function MetricSparkline({ values, label, color = "var(--color-primary)", className }: {
  values: number[]; label: string; color?: string; className?: string;
}) {
  const id = useId();
  const p = useMemo(() => path(values), [values]);
  if (values.length < 2) return <p className="text-xs text-text-muted">Недостаточно данных</p>;
  return (
    <svg role="img" aria-label={label} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className={className ?? "h-8 w-full"}>
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.28" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={p.area} fill={`url(#${id})`} />
      <path d={p.line} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

export interface Series { key: "cpu" | "ram" | "disk"; label: string; color: string }

export const SERIES: Series[] = [
  { key: "cpu", label: "CPU", color: "var(--color-primary)" },
  { key: "ram", label: "RAM", color: "var(--color-info)" },
  { key: "disk", label: "Диск", color: "var(--color-ai)" },
];

/** Интерактивный график по измерениям с метками времени UTC. Данные приходят снаружи, ничего не генерируется. */
export function MetricChart({ samples, series = SERIES, height = 200 }: { samples: MetricSample[]; series?: Series[]; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const paths = useMemo(() => series.map((s) => ({ s, p: path(samples.map((x) => x[s.key])) })), [samples, series]);
  if (samples.length < 2) return <p className="text-sm text-text-muted">Недостаточно данных</p>;

  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    setHover(Math.round(ratio * (samples.length - 1)));
  };
  const cur = hover != null ? samples[hover] : null;
  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  const mid = samples[Math.floor(samples.length / 2)]!;
  const tick = (s: MetricSample) => formatDateTimeUtc(s.t).replace(" UTC", "");

  return (
    <figure className="w-full">
      <div className="flex">
        <div className="flex w-9 shrink-0 flex-col justify-between pb-6 pr-2 text-right text-[11px] text-text-muted tabular" style={{ height }} aria-hidden>
          <span>100%</span><span>50%</span><span>0%</span>
        </div>
        <div className="min-w-0 flex-1">
          <div
            className="relative touch-pan-y"
            style={{ height: height - 24 }}
            onPointerMove={onMove}
            onPointerLeave={() => setHover(null)}
          >
            <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="absolute inset-0 size-full" role="img"
              aria-label={`График CPU, RAM и диска за период с ${formatDateTimeUtc(first.t)} по ${formatDateTimeUtc(last.t)}`}>
              {[0, 0.5, 1].map((g) => (
                <line key={g} x1="0" x2={W} y1={H * g} y2={H * g} stroke="var(--color-stroke)" strokeWidth="1" vectorEffect="non-scaling-stroke" strokeDasharray={g === 1 ? undefined : "3 4"} />
              ))}
              {paths.map(({ s, p }) => (
                <path key={s.key} d={p.line} fill="none" stroke={s.color} strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
              ))}
              {hover != null && (
                <line x1={(hover / (samples.length - 1)) * W} x2={(hover / (samples.length - 1)) * W} y1="0" y2={H} stroke="var(--color-text-muted)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
              )}
            </svg>
            {cur && (
              <div
                className="pointer-events-none absolute top-1 z-10 w-44 rounded-control border border-stroke bg-elevated p-2 text-xs shadow-[var(--shadow-overlay)]"
                style={{ left: `clamp(0px, calc(${(hover! / (samples.length - 1)) * 100}% - 88px), calc(100% - 176px))` }}
              >
                <p className="mb-1 text-text-secondary">{formatDateTimeUtc(cur.t)}</p>
                {series.map((s) => (
                  <p key={s.key} className="flex items-center justify-between gap-2 tabular">
                    <span className="flex items-center gap-1.5"><i className="inline-block size-2 rounded-full" style={{ background: s.color }} />{s.label}</span>
                    <span>{cur[s.key].toFixed(1)}%</span>
                  </p>
                ))}
              </div>
            )}
          </div>
          <div className="mt-2 flex justify-between text-[11px] text-text-muted tabular" aria-hidden>
            <span>{tick(first)}</span><span>{tick(mid)}</span><span>{tick(last)}</span>
          </div>
        </div>
      </div>
      <figcaption className="mt-3 flex flex-wrap gap-x-4 gap-y-1 pl-9 text-xs text-text-secondary">
        {series.map((s) => (
          <span key={s.key} className="flex items-center gap-1.5 tabular">
            <i className="inline-block size-2 rounded-full" style={{ background: s.color }} aria-hidden />
            {s.label}: {last[s.key].toFixed(1)}%
          </span>
        ))}
        <span className="text-text-muted">UTC · точек: {samples.length}</span>
      </figcaption>
    </figure>
  );
}
