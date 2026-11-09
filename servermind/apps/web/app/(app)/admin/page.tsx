import type { Metadata } from "next";
import { AdminView } from "@/features/admin/admin-view";

export const metadata: Metadata = { title: "Админка" };

export default function Page() {
  return <AdminView />;
}
