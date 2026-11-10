"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { getApi, type Api } from "./api";

export interface QueryState<T> { data: T | null; error: Error | null; loading: boolean; reload: () => void }

/** Загрузка данных с повторным запросом при любом изменении в API (mock/live subscribe). */
export function useQuery<T>(fn: (api: Api) => Promise<T>, deps: unknown[] = []): QueryState<T> {
  const [state, setState] = useState<{ data: T | null; error: Error | null; loading: boolean }>({ data: null, error: null, loading: true });
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const counter = useRef(0);

  const run = useCallback((initial: boolean) => {
    const id = ++counter.current;
    if (initial) setState({ data: null, error: null, loading: true });
    fnRef.current(getApi()).then(
      (data) => { if (id === counter.current) setState({ data, error: null, loading: false }); },
      (error: Error) => { if (id === counter.current) setState((s) => ({ data: initial ? null : s.data, error, loading: false })); },
    );
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { run(true); }, [run, ...deps]);
  useEffect(() => getApi().subscribe(() => run(false)), [run]);

  return { ...state, reload: () => run(true) };
}

export function useDocumentTitle(title: string) {
  useEffect(() => { document.title = `${title} — LeadHunter`; }, [title]);
}

export function fmtDate(iso: string): string {
  return new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Moscow" }).format(new Date(iso));
}
export function fmtDay(iso: string): string {
  return new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Moscow" }).format(new Date(iso));
}
export function fmtRel(iso: string): string {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (m < 1) return "только что";
  if (m < 60) return `${m} мин назад`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} ч назад`;
  const d = Math.round(h / 24);
  return d === 1 ? "вчера" : `${d} дн назад`;
}
