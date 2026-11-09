import type { Metadata } from "next";
import { OperationsView } from "@/features/operations/operations-view";

export const metadata: Metadata = { title: "Операции" };

export default function Page() {
  return <OperationsView />;
}
