"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, type CSSProperties, type ReactNode } from "react";
import * as DM from "@radix-ui/react-dropdown-menu";
import { Check, ChevronsUpDown, LogOut, Menu, Zap } from "lucide-react";
import { api } from "@/lib/api";
import { useResource } from "@/lib/use-resource";
import { formatNumber } from "@/lib/format";
import { ToastProvider } from "@/lib/toast";
import { MotionProvider } from "@/components/ui/motion";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Drawer } from "@/components/ui/dialog";
import { DemoRibbon } from "@/components/layout/demo-ribbon";
import { Logo } from "@/components/layout/logo";
import { Notifications } from "@/components/layout/notifications";
import { MobileBottomNav, NavLinks, currentSection } from "@/components/layout/nav";

export function WorkspaceSwitch({ name }: { name: string }) {
  return (
    <DM.Root>
      <DM.Trigger className="flex h-11 w-full items-center gap-2.5 rounded-control border border-stroke bg-surface px-2.5 text-left text-sm transition-colors hover:bg-hover data-[state=open]:bg-hover">
        <span aria-hidden className="grid size-6 place-items-center rounded-md bg-ai/20 text-xs font-semibold text-ai">{name.slice(0, 1)}</span>
        <span className="flex-1 truncate font-medium">{name}</span>
        <ChevronsUpDown aria-hidden className="size-4 text-text-muted" />
      </DM.Trigger>
      <DM.Portal>
        <DM.Content align="start" sideOffset={6} className="z-50 w-[var(--radix-dropdown-menu-trigger-width)] min-w-56 rounded-card border border-stroke bg-elevated p-1.5 shadow-[var(--shadow-overlay)]">
          <DM.Label className="px-3 py-2 text-xs font-medium text-text-muted">Пространство</DM.Label>
          <DM.Item className="flex min-h-11 items-center gap-2 rounded-control px-3 text-sm outline-none data-[highlighted]:bg-hover">
            <Check aria-hidden className="size-4 text-primary" /> {name}
          </DM.Item>
          <DM.Item disabled className="flex min-h-11 items-center gap-2 rounded-control px-3 text-sm text-text-muted outline-none">
            Команды — скоро
          </DM.Item>
        </DM.Content>
      </DM.Portal>
    </DM.Root>
  );
}

function SidebarBody({ onNavigate }: { onNavigate?: () => void }) {
  const router = useRouter();
  const me = useResource(() => api.auth.me());
  const servers = useResource(() => api.servers.list());
  const ops = useResource(() => api.operations.list());
  const bal = useResource(() => api.billing.balance());

  const isAdmin = me.state.status === "ready" && me.state.data.role === "owner";
  const badges = {
    "/servers": servers.state.status === "ready" ? { value: servers.state.data.length, tone: "neutral" as const } : undefined,
    "/operations": ops.state.status === "ready" ? { value: ops.state.data.filter((o) => o.status === "waiting_approval").length, tone: "warning" as const } : undefined,
  };

  const logout = async () => {
    await api.auth.logout();
    router.push("/login");
  };

  return (
    <>
      <div className="flex flex-col gap-4 p-4">
        <Link href="/dashboard" onClick={onNavigate} className="inline-flex h-10 items-center rounded-control px-1"><Logo /></Link>
        <WorkspaceSwitch name={me.state.status === "ready" ? me.state.data.workspace : "Рабочее пространство"} />
      </div>
      <div className="flex-1 overflow-y-auto px-3 pb-3">
        <NavLinks isAdmin={isAdmin} badges={badges} onNavigate={onNavigate} />
      </div>
      <div className="space-y-3 border-t border-stroke p-4">
        <Link
          href="/billing"
          onClick={onNavigate}
          className="block rounded-card border border-stroke bg-surface p-3 transition-colors hover:bg-hover"
        >
          <span className="flex items-center gap-2 text-xs text-text-secondary"><Zap aria-hidden className="size-3.5 text-primary" /> AI-кредиты</span>
          <span className="kpi mt-1 block text-[20px] leading-7">
            {bal.state.status === "ready" ? formatNumber(bal.state.data.available) : bal.state.status === "loading" ? "…" : "—"}
          </span>
          <span className="text-xs text-text-muted">
            {bal.state.status === "error" ? "Данные недоступны" : "Баланс по ledger"}
          </span>
        </Link>
        <div className="flex items-center gap-3">
          <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-full bg-elevated text-sm font-semibold">
            {me.state.status === "ready" ? me.state.data.name.slice(0, 1) : "?"}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{me.state.status === "ready" ? me.state.data.name : "Не авторизован"}</p>
            <p className="truncate text-xs text-text-muted">{me.state.status === "ready" ? me.state.data.email : "Нет сессии"}</p>
          </div>
          <button
            type="button"
            onClick={logout}
            aria-label="Выйти"
            className="grid size-11 shrink-0 place-items-center rounded-control text-text-muted transition-colors hover:bg-hover hover:text-text"
          >
            <LogOut aria-hidden className="size-4" />
          </button>
        </div>
      </div>
    </>
  );
}

/** Рабочие экраны, где нижняя навигация скрыта (фокус-режим: composer, подтверждение). */
function hidesBottomNav(pathname: string) {
  return pathname.startsWith("/assistant") || /\/approve$/.test(pathname);
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [drawer, setDrawer] = useState(false);
  const focusMode = hidesBottomNav(pathname);
  const style = { "--ribbon-h": process.env.NEXT_PUBLIC_DEV_FIXTURES === "1" ? "28px" : "0px" } as CSSProperties;

  return (
    <MotionProvider>
      <TooltipProvider delayDuration={200}>
        <ToastProvider>
          <div style={style} className="min-h-dvh bg-canvas">
            <a href="#main" className="sr-only z-[100] rounded-control bg-primary px-4 py-2 text-canvas focus:not-sr-only focus:fixed focus:left-4 focus:top-4">
              Перейти к содержимому
            </a>
            <DemoRibbon />
            <div className="flex">
              <aside className="sticky top-[var(--ribbon-h)] hidden h-[calc(100dvh-var(--ribbon-h))] w-[var(--shell-sidebar)] shrink-0 flex-col border-r border-stroke bg-sidebar lg:flex">
                <SidebarBody />
              </aside>
              <div className="flex min-w-0 flex-1 flex-col">
                <header className="sticky top-[var(--ribbon-h)] z-30 flex h-[var(--shell-topbar)] items-center gap-2 border-b border-stroke bg-canvas/90 px-3 backdrop-blur sm:px-6 lg:px-8">
                  <button
                    type="button"
                    onClick={() => setDrawer(true)}
                    aria-label="Открыть меню"
                    aria-haspopup="dialog"
                    className="grid size-11 place-items-center rounded-control text-text-secondary transition-colors hover:bg-hover hover:text-text lg:hidden"
                  >
                    <Menu aria-hidden className="size-5" />
                  </button>
                  <Link href="/dashboard" className="lg:hidden" aria-label="ServerMind — на главную"><Logo /></Link>
                  <p className="hidden text-sm font-medium text-text-secondary lg:block">{currentSection(pathname)}</p>
                  <div className="ml-auto"><Notifications /></div>
                </header>
                <main
                  id="main"
                  tabIndex={-1}
                  className={`mx-auto w-full max-w-[1480px] flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8 ${focusMode ? "pb-6" : "pb-[calc(88px+env(safe-area-inset-bottom))]"} lg:pb-8`}
                >
                  {children}
                </main>
              </div>
            </div>
            {!focusMode && <MobileBottomNav onMore={() => setDrawer(true)} />}
            <Drawer open={drawer} onOpenChange={setDrawer} title="Меню">
              <SidebarBody onNavigate={() => setDrawer(false)} />
            </Drawer>
          </div>
        </ToastProvider>
      </TooltipProvider>
    </MotionProvider>
  );
}
