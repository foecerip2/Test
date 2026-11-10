import type { Metadata } from "next";
import { ServersView } from "@/features/servers/servers-view";

export const metadata: Metadata = { title: "Серверы" };

export default function Page() {
  return <ServersView />;
}
