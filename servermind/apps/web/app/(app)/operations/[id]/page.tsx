import type { Metadata } from "next";
import { OperationDetailView } from "@/features/operations/operation-detail-view";

export const metadata: Metadata = { title: "Операция" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <OperationDetailView id={id} />;
}
