import type { Metadata } from "next";
import { DeployView } from "@/features/deploy/deploy-view";

export const metadata: Metadata = { title: "Деплой" };

export default function Page() {
  return <DeployView />;
}
