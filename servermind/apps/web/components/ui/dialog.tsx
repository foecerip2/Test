"use client";

import * as D from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { cn } from "@/lib/utils";

export const Dialog = D.Root;
export const DialogTrigger = D.Trigger;
export const DialogClose = D.Close;

function Overlay() {
  return <D.Overlay className="sm-overlay fixed inset-0 z-50 bg-canvas/75 backdrop-blur-[2px]" />;
}

/** Диалог: на телефоне — нижний sheet, на ≥sm — по центру. Фокус-ловушка и Esc обеспечивает Radix. */
export function DialogContent({
  className, children, title, description, hideClose, ...props
}: Omit<ComponentPropsWithoutRef<typeof D.Content>, "title"> & { title: string; description?: ReactNode; hideClose?: boolean }) {
  return (
    <D.Portal>
      <Overlay />
      <D.Content
        className={cn(
          "sm-dialog fixed z-50 flex max-h-[92dvh] w-full flex-col border border-stroke bg-surface shadow-[var(--shadow-overlay)]",
          "inset-x-0 bottom-0 rounded-t-dialog pb-[env(safe-area-inset-bottom)]",
          "sm:inset-x-auto sm:bottom-auto sm:left-1/2 sm:top-1/2 sm:max-w-lg sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-dialog sm:pb-0",
          className,
        )}
        {...props}
      >
        <div className="flex items-start justify-between gap-4 border-b border-stroke p-5">
          <div className="min-w-0">
            <D.Title className="text-[17px] font-semibold leading-6">{title}</D.Title>
            {description ? (
              <D.Description className="mt-1 text-sm text-text-secondary">{description}</D.Description>
            ) : (
              <D.Description className="sr-only">{title}</D.Description>
            )}
          </div>
          {!hideClose && (
            <D.Close
              aria-label="Закрыть"
              className="-m-2 grid size-11 shrink-0 place-items-center rounded-control text-text-muted transition-colors hover:bg-hover hover:text-text"
            >
              <X className="size-4" />
            </D.Close>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </D.Content>
    </D.Portal>
  );
}

export function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("flex flex-col-reverse gap-2 border-t border-stroke p-4 sm:flex-row sm:justify-end sm:px-5", className)}
      {...props}
    />
  );
}

/** Боковая панель (drawer) для мобильной навигации. */
export function Drawer({ children, title, ...props }: ComponentPropsWithoutRef<typeof D.Root> & { title: string }) {
  return (
    <D.Root {...props}>
      <D.Portal>
        <Overlay />
        <D.Content className="sm-drawer fixed inset-y-0 left-0 z-50 flex w-[min(86vw,320px)] flex-col border-r border-stroke bg-sidebar pb-[env(safe-area-inset-bottom)]">
          <D.Title className="sr-only">{title}</D.Title>
          <D.Description className="sr-only">Навигация по разделам</D.Description>
          {children}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
