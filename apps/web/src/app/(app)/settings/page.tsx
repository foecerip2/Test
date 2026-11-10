"use client";
import { useState } from "react";
import { AiTab } from "@/components/settings/AiTab";
import { AuditTab } from "@/components/settings/AuditTab";
import { BackupsTab } from "@/components/settings/BackupsTab";
import { ChannelsTab } from "@/components/settings/ChannelsTab";
import { SecurityTab } from "@/components/settings/SecurityTab";
import { SuppressionTab } from "@/components/settings/SuppressionTab";
import { PageHeader, Tabs } from "@/components/ui";
import { useDocumentTitle } from "@/lib/hooks";

const TABS = [
  { id: "ai", label: "AI" }, { id: "channels", label: "Каналы" }, { id: "security", label: "Безопасность и отправка" },
  { id: "suppression", label: "Подавление" }, { id: "audit", label: "Журнал аудита" }, { id: "backups", label: "Резервные копии" },
];

export default function SettingsPage() {
  useDocumentTitle("Настройки");
  const [tab, setTab] = useState("ai");
  return (
    <>
      <PageHeader eyebrow="Управление / интеграции" title="Настройки" subtitle="Секреты в интерфейсе не вводятся и не отображаются. Отправка по умолчанию запрещена." />
      <Tabs tabs={TABS} value={tab} onChange={setTab} label="Разделы настроек" />
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} tabIndex={0}>
        {tab === "ai" && <AiTab />}
        {tab === "channels" && <ChannelsTab />}
        {tab === "security" && <SecurityTab />}
        {tab === "suppression" && <SuppressionTab />}
        {tab === "audit" && <AuditTab />}
        {tab === "backups" && <BackupsTab />}
      </div>
    </>
  );
}
