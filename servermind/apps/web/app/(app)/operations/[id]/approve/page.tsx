import type { Metadata } from "next";
import { ApproveView } from "@/features/operations/approve-view";

export const metadata: Metadata = { title: "Подтверждение плана" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ApproveView operationId={id} />;
}
