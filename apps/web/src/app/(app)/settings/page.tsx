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
import { ComingSoon, PageHeader, Tabs } from "@/components/ui";
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
  const live = process.env.NEXT_PUBLIC_DATA_MODE === "live";
  const [tab, setTab] = useState("ai");
  const me = useQuery((a) => a.auth.me());
  const isOwner = me.data?.role === "owner";
  const tabs = isOwner ? [...TABS, USERS_TAB] : TABS;
  // Ссылка из колокольчика и обзора: /settings?tab=users
  const wanted = params.get("tab");
  useEffect(() => {
    if (wanted && [...TABS, USERS_TAB].some((x) => x.id === wanted)) setTab(wanted);
  }, [wanted]);
  // В рабочем режиме единственная живая вкладка — «Пользователи»: владельца открываем сразу на ней.
  useEffect(() => {
    if (live && isOwner && !wanted) setTab("users");
  }, [live, isOwner, wanted]);
  return (
    <>
      <PageHeader eyebrow="Управление / интеграции" title="Настройки" subtitle={live ? "Секреты в интерфейсе не вводятся и не отображаются. Сейчас доступно управление пользователями; остальное появится в следующих обновлениях." : "Секреты в интерфейсе не вводятся и не отображаются. Отправка по умолчанию запрещена."} />
      <Tabs tabs={tabs} value={tab} onChange={setTab} label="Разделы настроек" />
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} tabIndex={0}>
        {/* Рабочий режим: на сервере этих настроек ещё нет — честное «скоро» вместо демо-значений и кнопок-пустышек. */}
        {tab !== "users" && live && <ComingSoon text={`Вкладка «${TABS.find((x) => x.id === tab)?.label ?? ""}» ещё не подключена к серверу, поэтому настроек и данных здесь нет. Отправка сообщений выключена.`} />}
        {!live && tab === "ai" && <AiTab />}
        {!live && tab === "channels" && <ChannelsTab />}
        {!live && tab === "security" && <SecurityTab />}
        {!live && tab === "suppression" && <SuppressionTab />}
        {!live && tab === "audit" && <AuditTab />}
        {!live && tab === "backups" && <BackupsTab />}
        {tab === "users" && (me.data && !isOwner ? <UsersNoAccess /> : isOwner ? <UsersTab /> : null)}
      </div>
    </>
  );
}
