"use client";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { UsersNoAccess, UsersTab } from "@/components/settings/UsersTab";
import { AiTab } from "@/components/settings/AiTab";
import { AuditTab } from "@/components/settings/AuditTab";
import { BackupsTab } from "@/components/settings/BackupsTab";
import { ChannelsTab } from "@/components/settings/ChannelsTab";
import { SecurityTab } from "@/components/settings/SecurityTab";
import { SuppressionTab } from "@/components/settings/SuppressionTab";
import { PageHeader, Tabs } from "@/components/ui";
import { useDocumentTitle, useQuery } from "@/lib/hooks";

const TABS = [
  { id: "ai", label: "AI" }, { id: "channels", label: "Каналы" }, { id: "security", label: "Безопасность и отправка" },
  { id: "suppression", label: "Подавление" }, { id: "audit", label: "Журнал аудита" }, { id: "backups", label: "Резервные копии" },
];

const USERS_TAB = { id: "users", label: "Пользователи" };

export default function SettingsPage() {
  return <Suspense fallback={null}><SettingsView /></Suspense>;
}

function SettingsView() {
  useDocumentTitle("Настройки");
  const params = useSearchParams();
  const [tab, setTab] = useState("ai");
  const me = useQuery((a) => a.auth.me());
  const isOwner = me.data?.role === "owner";
  const tabs = isOwner ? [...TABS, USERS_TAB] : TABS;
  // Ссылка из колокольчика и обзора: /settings?tab=users
  const wanted = params.get("tab");
  useEffect(() => {
    if (wanted && [...TABS, USERS_TAB].some((x) => x.id === wanted)) setTab(wanted);
  }, [wanted]);
  return (
    <>
      <PageHeader eyebrow="Управление / интеграции" title="Настройки" subtitle="Секреты в интерфейсе не вводятся и не отображаются. Отправка по умолчанию запрещена." />
      <Tabs tabs={tabs} value={tab} onChange={setTab} label="Разделы настроек" />
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} tabIndex={0}>
        {tab === "ai" && <AiTab />}
        {tab === "channels" && <ChannelsTab />}
        {tab === "security" && <SecurityTab />}
        {tab === "suppression" && <SuppressionTab />}
        {tab === "audit" && <AuditTab />}
        {tab === "backups" && <BackupsTab />}
        {tab === "users" && (me.data && !isOwner ? <UsersNoAccess /> : isOwner ? <UsersTab /> : null)}
      </div>
    </>
  );
}
