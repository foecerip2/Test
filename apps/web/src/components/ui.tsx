"use client";
import Link from "next/link";
import { Children, cloneElement, isValidElement, useRef, type ReactElement, type ReactNode } from "react";
import { Icon } from "./Icon";
import type { DisplayStatus, Tone } from "@/lib/api";
import { ApiError, SOON_TEXT, SOON_TITLE } from "@/lib/api";

export function PageHeader({ eyebrow, title, subtitle, actions }: { eyebrow: string; title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        {subtitle && <p className="subtitle">{subtitle}</p>}
      </div>
      {actions && <div className="head-buttons">{actions}</div>}
    </div>
  );
}

export function Panel({ title, subtitle, action, children, pad = false }: { title?: string; subtitle?: string; action?: ReactNode; children: ReactNode; pad?: boolean }) {
  return (
    <section className="panel">
      {title && (
        <div className="panel-heading">
          <div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>
          {action}
        </div>
      )}
      {pad ? <div className="panel-body">{children}</div> : children}
    </section>
  );
}

export function StatusTag({ status, tone, children }: { status?: DisplayStatus; tone?: Tone; children?: ReactNode }) {
  const t = status?.tone ?? tone ?? "neutral";
  return <span className={`tag ${t === "neutral" ? "" : t}`}>{status?.label ?? children}</span>;
}


export function ScoreBadge({ score, threshold = 75 }: { score: number; threshold?: number }) {
  const cls = score >= threshold ? "" : score >= threshold - 15 ? "mid" : "low";
  return <span className={`score ${cls}`} title={`Оценка ${score} из 100, порог ${threshold}`}>{score}/100</span>;
}

export function MetricCard({ label, value, foot, icon }: { label: string; value: ReactNode; foot?: ReactNode; icon: string }) {
  return (
    <div className="metric">
      <div className="metric-label">{label}<Icon name={icon} /></div>
      <div className="metric-value">{value}</div>
      {foot && <div className="metric-foot">{foot}</div>}
    </div>
  );
}

/** level: 2 — если состояние стоит в панели без заголовка (иначе получится пропуск h1→h3). */
export function EmptyState({ title, text, action, icon = "info", level = 3 }: { title: string; text?: string; action?: ReactNode; icon?: string; level?: 2 | 3 }) {
  const H = level === 2 ? "h2" : "h3";
  return (
    <div className="state">
      <div className="state-icon"><Icon name={icon} /></div>
      <H>{title}</H>
      {text && <p>{text}</p>}
      {action}
    </div>
  );
}

/** Раздел, которого ещё нет на сервере: честное состояние вместо демо-данных и кнопок-пустышек. */
export function ComingSoon({ title = SOON_TITLE, text = SOON_TEXT, icon = "clock", level = 2, boxed = true }: { title?: string; text?: string; icon?: string; level?: 2 | 3; boxed?: boolean }) {
  const state = <EmptyState level={level} icon={icon} title={title} text={text} />;
  return boxed ? <div className="panel" data-testid="coming-soon">{state}</div> : <div data-testid="coming-soon">{state}</div>;
}

export function ErrorState({ error, onRetry, level = 3 }: { error: Error; onRetry?: () => void; level?: 1 | 2 | 3 }) {
  const H = (`h${level}`) as "h1" | "h2" | "h3";
  const denied = error instanceof ApiError && error.status === 403;
  const offline = typeof navigator !== "undefined" && !navigator.onLine;
  return (
    <div className="state error" role="alert">
      <div className="state-icon"><Icon name={denied ? "lock" : "alert"} /></div>
      <H>{denied ? "Нет доступа" : offline ? "Нет подключения к сети" : "Не удалось загрузить данные"}</H>
      <p>{denied ? "У вас нет прав для просмотра этого раздела." : offline ? "Проверьте интернет — данные обновятся при повторной попытке." : error.message || "Попробуйте ещё раз немного позже."}</p>
      {onRetry && <button className="btn" onClick={onRetry}><Icon name="refresh" /> Повторить</button>}
    </div>
  );
}

export function LoadingSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div role="status" aria-label="Загрузка">
      {Array.from({ length: rows }, (_, i) => <div key={i} className="skeleton skel-row" style={{ width: `${88 - (i % 3) * 14}%` }} />)}
      <span className="sr-only">Загрузка данных…</span>
    </div>
  );
}

export function Notice({ tone = "warn", icon = "shield", children }: { tone?: "warn" | "info" | "danger" | "ok"; icon?: string; children: ReactNode }) {
  return <div className={`notice ${tone === "warn" ? "" : tone}`}><Icon name={icon} /><div>{children}</div></div>;
}

export function ActivityFeed({ items }: { items: { id: string; icon: string; title: string; text: string; time: string; href?: string }[] }) {
  if (!items.length) return <EmptyState title="Событий пока нет" text="Они появятся после первого поиска или импорта." />;
  return (
    <ul className="feed">
      {items.map((a) => (
        <li key={a.id} className="feed-item">
          <span className="feed-icon"><Icon name={a.icon} /></span>
          <div className="feed-text"><strong>{a.href ? <Link href={a.href}>{a.title}</Link> : a.title}</strong><p>{a.text}</p></div>
          <span className="feed-time">{a.time}</span>
        </li>
      ))}
    </ul>
  );
}

export function Field({ label, htmlFor, hint, error, children }: { label: string; htmlFor: string; hint?: string; error?: string | null; children: ReactNode }) {
  // Связываем подсказку и ошибку с полем (aria-describedby), сохраняя собственные id поля.
  const own = Children.map(children, (ch) => {
    if (!isValidElement(ch)) return ch;
    const el = ch as ReactElement<{ id?: string; "aria-describedby"?: string }>;
    if (el.props.id !== htmlFor) return ch;
    const ids = new Set((el.props["aria-describedby"] ?? "").split(/\s+/).filter(Boolean));
    if (hint && !error) ids.add(`${htmlFor}-hint`);
    if (error) { ids.delete(`${htmlFor}-hint`); ids.add(`${htmlFor}-err`); }
    return cloneElement(el, { "aria-describedby": ids.size ? [...ids].join(" ") : undefined });
  });
  return (
    <div className="field">
      <label className="field-label" htmlFor={htmlFor}>{label}</label>
      {own}
      {hint && !error && <p className="field-hint" id={`${htmlFor}-hint`}>{hint}</p>}
      {error && <p className="field-error" id={`${htmlFor}-err`} role="alert">{error}</p>}
    </div>
  );
}

/** Вкладки WAI-ARIA: roving tabindex, стрелки/Home/End переносят фокус и активируют вкладку. */
export function Tabs({ tabs, value, onChange, label }: { tabs: { id: string; label: string }[]; value: string; onChange: (id: string) => void; label: string }) {
  const list = useRef<HTMLDivElement>(null);
  const go = (i: number) => {
    const t = tabs[(i + tabs.length) % tabs.length]!;
    onChange(t.id);
    list.current?.querySelector<HTMLElement>(`#tab-${CSS.escape(t.id)}`)?.focus();
  };
  return (
    <div className="tabs" role="tablist" aria-label={label} ref={list}>
      {tabs.map((t, idx) => (
        <button key={t.id} type="button" role="tab" id={`tab-${t.id}`} aria-selected={value === t.id} aria-controls={value === t.id ? `panel-${t.id}` : undefined} tabIndex={value === t.id ? 0 : -1} className="tab" onClick={() => onChange(t.id)}
          onKeyDown={(e) => {
            const k = e.key;
            if (k === "ArrowRight") go(idx + 1);
            else if (k === "ArrowLeft") go(idx - 1);
            else if (k === "Home") go(0);
            else if (k === "End") go(tabs.length - 1);
            else return;
            e.preventDefault();
          }}>{t.label}</button>
      ))}
    </div>
  );
}

export function Switch({ checked, onChange, label, id, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; id: string; disabled?: boolean }) {
  return (
    <div className="switch">
      <button id={id} role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)} />
      <label htmlFor={id}>{label}</label>
    </div>
  );
}

/** Универсальная обработка результата запроса: loading → error → empty → content. */
export function Async<T>({ q, children, empty, rows }: { q: { data: T | null; error: Error | null; loading: boolean; reload: () => void }; children: (d: T) => ReactNode; empty?: (d: T) => boolean; rows?: number }) {
  if (q.loading && !q.data) return <LoadingSkeleton rows={rows} />;
  if (q.error && !q.data) return <ErrorState error={q.error} onRetry={q.reload} />;
  if (!q.data) return null;
  if (empty?.(q.data)) return null;
  return <>{children(q.data)}</>;
}
