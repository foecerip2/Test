import type { Metadata } from "next";
import { ServerDetailView } from "@/features/servers/server-detail-view";

export const metadata: Metadata = { title: "Сервер" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ServerDetailView id={id} />;
}
