"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "./Icon";
import { Async, ErrorState } from "./ui";
import { getApi } from "@/lib/api";
import { useQuery } from "@/lib/hooks";

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
  "/overview": "Обзор", "/discovery": "Поиск компаний", "/companies": "База компаний", "/approvals": "Согласование",
  "/inbox": "Диалоги", "/pipeline": "Воронка продаж", "/analytics": "Аналитика", "/settings": "Настройки",
};

function useOutside(ref: React.RefObject<HTMLElement | null>, open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) close(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [ref, open, close]);
}

export function AppShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const path = usePathname();
  const [authed, setAuthed] = useState<"loading" | "yes">("loading");
  const [drawer, setDrawer] = useState(false);
  const [bell, setBell] = useState(false);
  const [profile, setProfile] = useState(false);
  const bellRef = useRef<HTMLDivElement>(null);
  const profRef = useRef<HTMLDivElement>(null);
  const menuBtn = useRef<HTMLButtonElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);

  const me = useQuery((a) => a.auth.me());
  const summary = useQuery((a) => a.summary());
  const settings = useQuery((a) => a.settings.get());

  useEffect(() => {
    if (me.loading || me.error) return;
    if (me.data) setAuthed("yes");
    else router.replace("/login");
  }, [me.loading, me.error, me.data, router]);

  useEffect(() => { setDrawer(false); setBell(false); setProfile(false); }, [path]);
  useOutside(bellRef, bell, () => setBell(false));
  useOutside(profRef, profile, () => setProfile(false));
  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setDrawer(false); menuBtn.current?.focus(); } };
    document.addEventListener("keydown", onKey);
    sidebarRef.current?.querySelector<HTMLElement>("a")?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [drawer]);

  if (me.error && !me.data) return <ErrorState error={me.error} onRetry={me.reload} />;
  if (authed !== "yes") return <div className="state" role="status"><p>Загрузка…</p></div>;

  const s = summary.data;
  const counts: Record<string, number | undefined> = { companies: s?.companiesTotal, approvals: s?.awaitingApproval, inbox: s?.unread };
  const title = Object.entries(PAGE_TITLES).find(([k]) => path === k || path.startsWith(k + "/"))?.[1] ?? "";
  const isDetail = path.startsWith("/companies/");
  const mock = getApi().mode === "mock";
  const att = s?.attention ?? [];
  const urgent = att.filter((a) => a.tone !== "neutral").length;

  const link = (n: { href: string; label: string; icon: string; count?: string }) => {
    const active = path === n.href || path.startsWith(n.href + "/");
    const c = n.count ? counts[n.count] : undefined;
    return (
      <Link key={n.href} href={n.href} className="nav-link" aria-current={active ? "page" : undefined}>
        <Icon name={n.icon} /><span>{n.label}</span>
        {c !== undefined && c > 0 && <span className={`nav-count ${n.count === "approvals" ? "hot" : ""}`} aria-label={`${c}`}>{c}</span>}
      </Link>
    );
  };

  return (
    <div className="app-shell">
      <a className="skip-link" href="#content">Перейти к содержимому</a>
      <aside className={`sidebar ${drawer ? "open" : ""}`} id="sidebar" ref={sidebarRef} aria-label="Основная навигация">
        <Link href="/overview" className="brand" aria-label="LeadHunter — на главную">
          <div className="brand-mark" aria-hidden="true"><span /><span /><span /><span /></div>
          <div><div className="brand-name">leadhunter<span className="brand-dot">.</span></div><div className="brand-sub">PRIVATE WORKSPACE</div></div>
        </Link>
        <div className="nav-label" id="nav-main">Рабочее пространство</div>
        <nav className="nav" aria-labelledby="nav-main">{NAV_MAIN.map(link)}</nav>
        <div className="nav-label second" id="nav-sys">Система</div>
        <nav className="nav" aria-labelledby="nav-sys">{NAV_SYS.map(link)}</nav>
        <div className="sidebar-spacer" />
        <div className="mode-card">
          <h2>Режим работы</h2>
          <div className="mode-row"><span>Отправка</span><span className={`tag ${settings.data?.emergencyStopSend === false ? "amber" : "green"}`}>{settings.data ? (settings.data.emergencyStopSend ? "Выключена" : "Включена") : "…"}</span></div>
          <div className="mode-row"><span>AI</span><span className="tag">{settings.data ? ({ none: "Без AI", api: "Через API", manual: "Вручную" }[settings.data.aiMode]) : "…"}</span></div>
          <div className="mode-row"><span>Данные</span><span className={`tag ${mock ? "amber" : "green"}`}>{mock ? "Демо" : "Рабочие"}</span></div>
          <div className="mode-row"><Link href="/settings">Изменить в настройках</Link></div>
        </div>
        <div className="profile-wrap" ref={profRef}>
          {profile && (
            <div className="menu up" role="menu">
              <button role="menuitem" onClick={async () => { await getApi().auth.logout(); router.replace("/login"); }}><Icon name="logout" /> Выйти</button>
            </div>
          )}
          <button className="profile" aria-haspopup="menu" aria-expanded={profile} onClick={() => setProfile((v) => !v)}>
            <span className="avatar">{me.data?.initials ?? "—"}</span>
            <span><strong>{me.data?.name}</strong><small>{me.data?.email}</small></span>
          </button>
        </div>
      </aside>
      <div className={`overlay ${drawer ? "open" : ""}`} onClick={() => { setDrawer(false); menuBtn.current?.focus(); }} aria-hidden="true" />
      <div className="main-area">
        <header className="topbar">
          <div className="breadcrumb">
            <button className="icon-btn mobile-menu" ref={menuBtn} aria-label="Открыть меню" aria-expanded={drawer} aria-controls="sidebar" onClick={() => setDrawer(true)}><Icon name="menu" /></button>
            <span className="crumb-muted crumb-root">Рабочее пространство</span><span className="slash crumb-root" aria-hidden="true">/</span>
            {isDetail ? <><Link href="/companies" className="crumb-muted" style={{ textDecoration: "none" }}>База компаний</Link><span className="slash" aria-hidden="true">/</span><strong>Карточка</strong></> : <strong>{title}</strong>}
          </div>
          <div className="top-actions" ref={bellRef}>
            {mock && <span className="status-pill"><i /><span className="pill-long">Демо-данные · без отправки</span><span className="pill-short">Демо</span></span>}
            <button className="icon-btn" aria-label={`Уведомления${urgent ? `: ${urgent}` : ""}`} aria-haspopup="true" aria-expanded={bell} onClick={() => setBell((v) => !v)}>
              <Icon name="bell" />{urgent > 0 && <span className="badge-dot">{urgent}</span>}
            </button>
            {bell && (
              <div className="menu down" role="region" aria-label="Уведомления">
                <Async q={summary} rows={3}>
                  {(d) => d.attention.length === 0
                    ? <div className="state" style={{ padding: 24 }}><p style={{ margin: 0 }}>Нет событий, требующих внимания</p></div>
                    : <ul className="feed" style={{ padding: "6px 14px" }}>{d.attention.map((a) => (
                        <li key={a.id} className="feed-item"><span className="feed-icon" style={a.tone === "red" ? { background: "var(--red-tint)", color: "var(--red)" } : undefined}><Icon name={a.tone === "red" ? "alert" : "bell"} /></span>
                          <div className="feed-text"><strong><Link href={a.href}>{a.title}</Link></strong><p>{a.text}</p></div></li>))}</ul>}
                </Async>
              </div>
            )}
            <span className="avatar" style={{ width: 32, height: 32 }} aria-hidden="true">{me.data?.initials}</span>
          </div>
        </header>
        <main id="content" tabIndex={-1}>{children}</main>
      </div>
    </div>
  );
}
