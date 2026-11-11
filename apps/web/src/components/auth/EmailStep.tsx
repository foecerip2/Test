"use client";
import type { Ref } from "react";
import { Field } from "@/components/ui";
import s from "./auth.module.css";

/** Шаг 1: единый вход «Войти или создать аккаунт» — только email. */
export function EmailStep({ value, onChange, onSubmit, busy, error, demo, inputRef }: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  busy: boolean;
  error: string | null;
  /** Демо-режим: показываем подсказку про код. */
  demo: boolean;
  inputRef?: Ref<HTMLInputElement>;
}) {
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (!busy) onSubmit(); }} noValidate>
      <Field label="Email" htmlFor="email" error={error}>
        <input
          id="email" ref={inputRef} className="input" type="email" name="email"
          autoComplete="email" inputMode="email" autoCapitalize="off" autoCorrect="off" spellCheck={false}
          placeholder="name@company.ru" value={value} onChange={(e) => onChange(e.target.value)}
          aria-invalid={!!error} aria-required="true"
        />
      </Field>
      <button className={`btn btn-primary ${s.wide}`} type="submit" disabled={busy || !value.trim()}>
        {busy ? <><span className={`${s.spinner} ${s.onAccent}`} aria-hidden="true" />Отправляем код…</> : "Получить код"}
      </button>
      {demo && <div className={s.demo}>Демо: код подтверждения <b>123456</b></div>}
    </form>
  );
}
