import type { Metadata } from "next";
import { PageHeader } from "@/components/layout/page-header";
import { AddServerWizard } from "@/features/servers/add-server-wizard";

export const metadata: Metadata = { title: "Добавить сервер" };

export default function Page() {
  return (
    <>
      <PageHeader
        back={{ href: "/servers", label: "Серверы" }}
        title="Добавить сервер"
        description="Подключение по SSH-ключу к отдельному пользователю. Пароль root не запрашивается и не хранится."
      />
      <AddServerWizard />
    </>
  );
}
