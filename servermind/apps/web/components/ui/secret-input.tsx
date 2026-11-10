"use client";

import { forwardRef, useState, type InputHTMLAttributes } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * Поле секрета. Значение живёт только в состоянии формы — не пишется в localStorage/sessionStorage/URL.
 * autoComplete отключён, показать/скрыть доступно с клавиатуры.
 */
export const SecretInput = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, "type">>(function SecretInput(
  { className, ...props },
  ref,
) {
  const [shown, setShown] = useState(false);
  return (
    <div className="relative">
      <Input
        ref={ref}
        type={shown ? "text" : "password"}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        className={cn("pr-12 font-mono", className)}
        {...props}
      />
      <button
        type="button"
        aria-label={shown ? "Скрыть значение" : "Показать значение"}
        aria-pressed={shown}
        onClick={() => setShown((s) => !s)}
        className="absolute right-0 top-0 grid size-11 place-items-center rounded-control text-text-muted transition-colors hover:text-text"
      >
        {shown ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </button>
    </div>
  );
});
