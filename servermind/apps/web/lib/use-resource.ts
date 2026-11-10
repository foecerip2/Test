"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { ErrorCode, Result } from "@/lib/types";

export type ResourceState<T> =
  | { status: "loading" }
  | { status: "error"; code: ErrorCode; message: string }
  | { status: "ready"; data: T };

/**
 * Загружает ресурс, умеет перезагрузку и тихое обновление по событиям источника данных
 * (в dev-фикстурах — изменения стора; в боевом режиме — опциональный polling).
 */
export function useResource<T>(
  fetcher: () => Promise<Result<T>>,
  deps: ReadonlyArray<unknown> = [],
  opts: { pollMs?: number } = {},
) {
  const [state, setState] = useState<ResourceState<T>>({ status: "loading" });
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const seq = useRef(0);

  const run = useCallback(async (silent: boolean) => {
    const id = ++seq.current;
    if (!silent) setState({ status: "loading" });
    const res = await fetcherRef.current();
    if (id !== seq.current) return;
    setState(res.ok ? { status: "ready", data: res.data } : { status: "error", code: res.code, message: res.message });
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void run(false); }, [run, ...deps]);
  useEffect(() => api.subscribe(() => void run(true)), [run]);
  useEffect(() => {
    if (!opts.pollMs) return;
    const t = setInterval(() => void run(true), opts.pollMs);
    return () => clearInterval(t);
  }, [opts.pollMs, run]);

  return { state, reload: () => run(false) };
}
