import type { Metadata } from "next";
import { BillingView } from "@/features/billing/billing-view";

export const metadata: Metadata = { title: "Биллинг и AI" };

export default function Page() {
  return <BillingView />;
}
