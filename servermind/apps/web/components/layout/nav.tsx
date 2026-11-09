"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity, CreditCard, Ellipsis, LayoutDashboard, ListChecks, Rocket, Server, Settings, ShieldCheck, Sparkles,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

export interface NavItem { href: string; label: string; icon: LucideIcon; adminOnly?: boolean }

export const NAV_ITEMS: NavItem[] = [
  { href: "/dashboard", label: "Обзор", icon: LayoutDashboard },
  { href: "/servers", label: "Серверы", icon: Server },
  { href: "/assistant", label: "AI-ассистент", icon: Sparkles },
  { href: "/operations", label: "Операции", icon: ListChecks },
  { href: "/deploy", label: "Деплой", icon: Rocket },
  { href: "/monitoring", label: "Мониторинг", icon: Activity },
  { href: "/billing", label: "Биллинг", icon: CreditCard },
  { href: "/settings", label: "Настройки", icon: Settings },
  { href: "/admin", label: "Админка", icon: ShieldCheck, adminOnly: true },
];

export function isActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function currentSection(pathname: string): string {
  return NAV_ITEMS.find((i) => isActive(pathname, i.href))?.label ?? "ServerMind";
}

export function NavLinks({
  isAdmin, badges, onNavigate,
}: { isAdmin: boolean; badges: Record<string, { value: number; tone: "neutral" | "warning" } | undefined>; onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Основная навигация" className="flex flex-col gap-1">
      {NAV_ITEMS.filter((i) => !i.adminOnly || isAdmin).map((item) => {
        const active = isActive(pathname, item.href);
        const badge = badges[item.href];
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={cn(
              "group flex h-11 items-center gap-3 rounded-control px-3 text-sm font-medium transition-colors duration-120",
              active ? "bg-primary-muted text-primary" : "text-text-secondary hover:bg-hover hover:text-text",
            )}
          >
            <item.icon aria-hidden className="size-[18px] shrink-0" />
            <span className="flex-1 truncate">{item.label}</span>
            {badge && badge.value > 0 && (
              <span
                className={cn(
                  "tabular grid min-w-5 place-items-center rounded-full px-1.5 text-xs font-semibold leading-5",
                  badge.tone === "warning" ? "bg-warning text-canvas" : "bg-elevated text-text-secondary",
                )}
              >
                <span className="sr-only">{badge.tone === "warning" ? "ожидают подтверждения: " : "количество: "}</span>
                {badge.value}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}

/** Нижняя навигация (mobile): Обзор / Серверы / AI / Ещё. Остальные разделы — в drawer «Ещё». */
export function MobileBottomNav({ onMore }: { onMore: () => void }) {
  const pathname = usePathname();
  const items = [NAV_ITEMS[0]!, NAV_ITEMS[1]!, NAV_ITEMS[2]!];
  const short: Record<string, string> = { "/assistant": "AI" };
  const moreActive = !items.some((i) => isActive(pathname, i.href));
  const base = "flex h-14 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium transition-colors";
  return (
    <nav
      aria-label="Быстрая навигация"
      className="safe-bottom fixed inset-x-0 bottom-0 z-40 flex border-t border-stroke bg-sidebar/95 backdrop-blur lg:hidden"
    >
      {items.map((item) => {
        const active = isActive(pathname, item.href);
        return (
          <Link key={item.href} href={item.href} aria-current={active ? "page" : undefined} className={cn(base, active ? "text-primary" : "text-text-secondary")}>
            <item.icon aria-hidden className="size-5" />
            {short[item.href] ?? item.label}
          </Link>
        );
      })}
      <button type="button" onClick={onMore} aria-haspopup="dialog" className={cn(base, moreActive ? "text-primary" : "text-text-secondary")}>
        <Ellipsis aria-hidden className="size-5" />
        Ещё
      </button>
    </nav>
  );
}
