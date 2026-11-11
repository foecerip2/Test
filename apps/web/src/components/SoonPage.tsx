"use client";
import { ComingSoon, PageHeader } from "./ui";
import { useDocumentTitle } from "@/lib/hooks";

/** Страница раздела, который ещё не подключён к серверу (рабочий режим): заголовок и честное состояние, без демо-данных. */
export function SoonPage({ eyebrow, title, subtitle, text, icon }: { eyebrow: string; title: string; subtitle: string; text?: string; icon?: string }) {
  useDocumentTitle(title);
  return (
    <>
      <PageHeader eyebrow={eyebrow} title={title} subtitle={subtitle} />
      <ComingSoon text={text} icon={icon} />
    </>
  );
}
