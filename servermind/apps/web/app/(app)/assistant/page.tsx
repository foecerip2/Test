import type { Metadata } from "next";
import { Suspense } from "react";
import { AssistantView } from "@/features/assistant/assistant-view";

export const metadata: Metadata = { title: "AI-ассистент" };

export default function Page() {
  return (
    <Suspense fallback={null}>
      <AssistantView />
    </Suspense>
  );
}
