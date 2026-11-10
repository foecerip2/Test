import type { Metadata } from "next";
import { SettingsView } from "@/features/settings/settings-view";

export const metadata: Metadata = { title: "Настройки" };

export default function Page() {
  return <SettingsView />;
}
