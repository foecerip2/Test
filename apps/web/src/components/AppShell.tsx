"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "./Icon";
import { Async, ErrorState } from "./ui";
import { AccountBlocked, PendingApproval } from "./auth/PendingApproval";
import { getApi } from "@/lib/api";
import { userInitials, userLabel } from "@/lib/auth";
import { usePendingUsers, useQuery } from "@/lib/hooks";
import { pendingText } from "@/lib/users";

const NAV_MAIN = [
  { href: "/overview", label: "Обзор", icon: "layout" },
  { href: "/discovery", label: "Поиск компаний", icon: "radar" },
  { href: "/companies", label: "База компаний", icon: "building", count: "companies" },
  { href: "/approvals", label: "Согласование", icon: "check", count: "approvals" },
  { href: "/inbox", label: "Диалоги", icon: "chat", count: "inbox" },
  { href: "/pipeline", label: "Воронка продаж", icon: "columns" },
] as const;
const NAV_SYS = [
  { href: "/analytics", label: "Аналитика", icon: "chart" },
  { href: "/settings", label: "Настройки", icon: "settings" },
] as const;

export const PAGE_TITLES: Record<string, string> = {
  "/autoflow/pilots": "Заявки AutoFlow",
  "/overview": "Обзор", "/discovery": "Поиск компаний", "/companies": "База компаний", "/approvals": "Согласование",
  "/inbox": "Диалоги", "/pipeline": "Воронка продаж", "/analytics": "Аналитика", "/settings": "Настройки",
};

/** Закрытие всплывающего блока: клик снаружи, Esc (с возвратом фокуса на кнопку), уход фокуса за пределы. */
function useOutside(ref: React.RefObject<HTMLElement | null>, open: boolean, close: () => void, trigger: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) close(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { close(); trigger.current?.focus(); } };
    const onFocus = (e: FocusEvent) => { if (ref.current && e.target instanceof Node && !ref.current.contains(e.target)) close(); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    document.addEventListener("focusin", onFocus);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); document.removeEventListener("focusin", onFocus); };
  }, [ref, open, close, trigger]);
}

export function AppShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const path = usePathname();
  const [drawer, setDrawer] = useState(false);
  const [bell, setBell] = useState(false);
  const [profile, setProfile] = useState(false);
  const bellRef = useRef<HTMLDivElement>(null);
  const profRef = useRef<HTMLDivElement>(null);
  const menuBtn = useRef<HTMLButtonElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const bellBtn = useRef<HTMLButtonElement>(null);
  const profBtn = useRef<HTMLButtonElement>(null);
  const profMenu = useRef<HTMLDivElement>(null);
  const drawerWasOpen = useRef(false);
  const drawerReturnFocus = useRef(false);

  const me = useQuery((a) => a.auth.me());
  const summary = useQuery((a) => a.summary());
  // В рабочем режиме настроек на сервере ещё нет: не запрашиваем и не показываем выдуманные значения.
  const settings = useQuery(async (a) => (a.mode === "live" ? null : a.settings.get()));
  const pendingUsers = usePendingUsers(me.data?.role === "owner" && me.data.status === "active");

  useEffect(() => {
    if (me.loading || me.error) return;
    if (!me.data) router.replace("/login");
  }, [me.loading, me.error, me.data, router]);

  useEffect(() => { setDrawer(false); setBell(false); setProfile(false); }, [path]);
  useOutside(bellRef, bell, () => setBell(false), bellBtn);
  useOutside(profRef, profile, () => setProfile(false), profBtn);
  // Меню профиля: при открытии фокус на первый пункт.
  useEffect(() => { if (profile) profMenu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus(); }, [profile]);
  const closeDrawer = () => { drawerReturnFocus.current = true; setDrawer(false); };
  // Мобильный ящик ведёт себя как модальный: фокус внутрь, Tab по кругу, Esc закрывает,
  // остальная страница inert; после закрытия фокус возвращается на кнопку «Открыть меню».
  useEffect(() => {
    if (!drawer) {
      if (drawerWasOpen.current && drawerReturnFocus.current) menuBtn.current?.focus();
      drawerWasOpen.current = false; drawerReturnFocus.current = false;
      return;
    }
    drawerWasOpen.current = true;
    const el = sidebarRef.current;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { drawerReturnFocus.current = true; setDrawer(false); return; }
      if (e.key !== "Tab" || !el) return;
      const f = Array.from(el.querySelectorAll<HTMLElement>('a[href], button:not(:disabled)')).filter((x) => x.offsetParent !== null);
      if (!f.length) return;
      const first = f[0]!, last = f[f.length - 1]!;
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    el?.querySelector<HTMLElement>(".nav a")?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [drawer]);

  if (me.error && !me.data) return <ErrorState error={me.error} onRetry={me.reload} />;
  if (!me.data) return <div className="state" role="status"><p>Загрузка…</p></div>;
  if (me.data.status === "pending") return <PendingApproval user={me.data} onRecheck={me.reload} />;
  if (me.data.status === "blocked") return <AccountBlocked user={me.data} />;
  const user = me.data;
  const initials = userInitials(user);

  const s = summary.data;
  const counts: Record<string, number | undefined> = { pilots: user.role === "owner" ? s?.pilotRequestsNew : undefined, companies: s?.companiesTotal, approvals: s?.awaitingApproval, inbox: s?.unread };
  const title = Object.entries(PAGE_TITLES).find(([k]) => path === k || path.startsWith(k + "/"))?.[1] ?? "";
  const isDetail = path.startsWith("/companies/");
  const mock = process.env.NEXT_PUBLIC_DATA_MODE !== "live";
  const live = !mock;
  const att = [
    ...(pendingUsers ? [{ id: "n-users", title: pendingText(pendingUsers), text: "Откройте «Настройки → Пользователи», чтобы одобрить или отклонить доступ", href: "/settings?tab=users", tone: "amber" as const }] : []),
    ...(s?.attention ?? []),
  ];
  const urgent = att.filter((a) => a.tone !== "neutral").length;

  const link = (n: { href: string; label: string; icon: string; count?: string }) => {
    const active = path === n.href || path.startsWith(n.href + "/");
    const c = n.count ? counts[n.count] : undefined;
    return (
      <Link key={n.href} href={n.href} className="nav-link" aria-current={active ? "page" : undefined}>
        <Icon name={n.icon} /><span>{n.label}</span>
        {c !== undefined && c > 0 && <span className={`nav-count ${n.count === "approvals" ? "hot" : ""}`} >{c}</span>}
      </Link>
    );
  };

  return (
    <div className="app-shell">
      <a className="skip-link" href="#content">Перейти к содержимому</a>
      <aside className={`sidebar ${drawer ? "open" : ""}`} id="sidebar" ref={sidebarRef} aria-label="Основная навигация">
        <button type="button" className="icon-btn drawer-close" aria-label="Закрыть меню" onClick={closeDrawer}><Icon name="close" /></button>
        <Link href="/overview" className="brand">
          <div className="brand-mark" aria-hidden="true"><span /><span /><span /><span /></div>
          <div><div className="brand-name">leadhunter<span className="brand-dot">.</span></div><div className="brand-sub" lang="en">PRIVATE WORKSPACE</div></div>
          <span className="sr-only"> — на главную</span>
        </Link>
        <div className="nav-label" id="nav-main">Рабочее пространство</div>
        <nav className="nav" aria-labelledby="nav-main">{NAV_MAIN.map(link)}</nav>
        <div className="nav-label second" id="nav-sys">Система</div>
        <nav className="nav" aria-labelledby="nav-sys">{NAV_SYS.map(link)}{user.role === "owner" && live && link({ href: "/autoflow/pilots", label: "Заявки AutoFlow", icon: "bell", count: "pilots" })}</nav>
        <div className="sidebar-spacer" />
        <div className="mode-card">
          <h2>Режим работы</h2>
          {/* Рабочий режим: отправки сообщений в системе нет вовсе — это факт, а не настройка; AI-режима тоже нет. */}
          <div className="mode-row"><span>Отправка</span><span className={`tag ${settings.data?.emergencyStopSend === false ? "amber" : "green"}`}>{live ? "Выключена" : settings.data ? (settings.data.emergencyStopSend ? "Выключена" : "Включена") : "…"}</span></div>
          {!live && <div className="mode-row"><span>AI</span><span className="tag">{settings.data ? ({ none: "Без AI", api: "Через API", manual: "Вручную" }[settings.data.aiMode]) : "…"}</span></div>}
          <div className="mode-row"><span>Данные</span><span className={`tag ${mock ? "amber" : "green"}`}>{mock ? "Демо" : "Рабочие"}</span></div>
          <div className="mode-row"><Link href="/settings">Изменить в настройках</Link></div>
        </div>
        <div className="profile-wrap" ref={profRef}>
          <button className="profile" ref={profBtn} aria-haspopup="menu" aria-expanded={profile} aria-controls={profile ? "profile-menu" : undefined} onClick={() => setProfile((v) => !v)}
            onKeyDown={(e) => { if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !profile) { e.preventDefault(); setProfile(true); } }}>
            <span className="avatar" aria-hidden="true">{initials}</span>
            <span><strong>{userLabel(user)}</strong><small>{user.email}</small><span className="sr-only">, меню профиля</span></span>
          </button>
          {/* Меню идёт после кнопки в DOM, чтобы порядок фокуса совпадал с логикой; визуально оно над кнопкой. */}
          {profile && (
            <div className="menu up" role="menu" id="profile-menu" aria-label="Профиль" ref={profMenu}
              onKeyDown={(e) => {
                const items = Array.from(profMenu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
                const i = items.indexOf(document.activeElement as HTMLElement);
                if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
                else if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
                else if (e.key === "Home") { e.preventDefault(); items[0]?.focus(); }
                else if (e.key === "End") { e.preventDefault(); items[items.length - 1]?.focus(); }
                else if (e.key === "Tab") setProfile(false);
              }}>
              <button role="menuitem" tabIndex={-1} onClick={async () => { await getApi().auth.logout(); router.replace("/login"); }}><Icon name="logout" /> Выйти</button>
            </div>
          )}
        </div>
      </aside>
      <div className={`overlay ${drawer ? "open" : ""}`} onClick={closeDrawer} aria-hidden="true" />
      <div className="main-area" inert={drawer || undefined}>
        <header className="topbar">
          <div className="breadcrumb">
            <button className="icon-btn mobile-menu" ref={menuBtn} aria-label="Открыть меню" aria-expanded={drawer} aria-controls="sidebar" onClick={() => setDrawer(true)}><Icon name="menu" /></button>
            <span className="crumb-muted crumb-root">Рабочее пространство</span><span className="slash crumb-root" aria-hidden="true">/</span>
            {isDetail ? <><Link href="/companies" className="crumb-muted" style={{ textDecoration: "none" }}>База компаний</Link><span className="slash" aria-hidden="true">/</span><strong>Карточка</strong></> : <strong>{title}</strong>}
          </div>
          <div className="top-actions" ref={bellRef}>
            {mock && <span className="status-pill"><i /><span className="pill-long">Демо-данные · без отправки</span><span className="pill-short">Демо</span></span>}
            <button className="icon-btn" ref={bellBtn} aria-label={`Уведомления${urgent ? `: ${urgent}` : ""}`} aria-expanded={bell} aria-controls={bell ? "notif-panel" : undefined} onClick={() => setBell((v) => !v)}>
              <Icon name="bell" />{urgent > 0 && <span className="badge-dot">{urgent}</span>}
            </button>
            {bell && (
              <div className="menu down" role="region" aria-label="Уведомления" id="notif-panel">
                <Async q={summary} rows={3}>
                  {() => att.length === 0
                    ? <div className="state" style={{ padding: 24 }}><p style={{ margin: 0 }}>Нет событий, требующих внимания</p></div>
                    : <ul className="feed" style={{ padding: "6px 14px" }}>{att.map((a) => (
                        <li key={a.id} className="feed-item"><span className="feed-icon" style={a.tone === "red" ? { background: "var(--red-tint)", color: "var(--red)" } : undefined}><Icon name={a.tone === "red" ? "alert" : "bell"} /></span>
                          <div className="feed-text"><strong><Link href={a.href}>{a.title}</Link></strong><p>{a.text}</p></div></li>))}</ul>}
                </Async>
              </div>
            )}
            <span className="avatar" style={{ width: 32, height: 32 }} aria-hidden="true">{initials}</span>
          </div>
        </header>
        <main id="content" tabIndex={-1}>{children}</main>
      </div>
    </div>
  );
}
