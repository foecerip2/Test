import type { Metadata } from "next";
import { OnboardingView } from "@/features/onboarding/onboarding-view";

export const metadata: Metadata = { title: "Подключение сервера" };

export default function Page() {
  return <OnboardingView />;
}
