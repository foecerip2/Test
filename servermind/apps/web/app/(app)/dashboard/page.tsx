import type { Metadata } from "next";
import { DashboardView } from "@/features/dashboard/dashboard-view";

export const metadata: Metadata = { title: "Обзор" };

export default function Page() {
  return <DashboardView />;
}
