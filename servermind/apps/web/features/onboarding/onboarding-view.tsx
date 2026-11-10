"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowRight, Bot, ShieldCheck, Terminal } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { AddServerWizard } from "@/features/servers/add-server-wizard";

const KEY = "sm.onboarding.step.v1";

const FEATURES = [
  { icon: Terminal, title: "Реальное состояние", text: "CPU, RAM, диск и службы читаются по SSH. Если данных нет — так и написано." },
  { icon: Bot, title: "AI предлагает план", text: "Ассистент объясняет проблему и готовит структурированные шаги из списка одобренных операций." },
  { icon: ShieldCheck, title: "Вы подтверждаете", text: "Любое изменение показывается с риском и хешем плана и выполняется только после вашего подтверждения." },
];

export function OnboardingView() {
  const [phase, setPhase] = useState<"intro" | "wizard">("intro");

  useEffect(() => {
    try { if (localStorage.getItem(KEY) === "wizard") setPhase("wizard"); } catch { /* ignore */ }
  }, []);
  const go = (p: "intro" | "wizard") => {
    setPhase(p);
    try { localStorage.setItem(KEY, p); } catch { /* ignore */ }
  };

  return (
    <>
      <PageHeader
        title="Добро пожаловать в ServerMind"
        description={phase === "intro" ? "Шаг 1 из 3 · Обзор возможностей" : "Шаги 2–3 из 3 · Подключение VPS"}
      />
      {phase === "intro" ? (
        <div className="mx-auto max-w-3xl space-y-5">
          <div className="grid gap-4 md:grid-cols-3">
            {FEATURES.map((f) => (
              <Card key={f.title}>
                <CardContent className="space-y-3">
                  <span className="grid size-10 place-items-center rounded-control bg-primary-muted text-primary"><f.icon aria-hidden className="size-5" /></span>
                  <h3>{f.title}</h3>
                  <p className="text-sm text-text-secondary">{f.text}</p>
                </CardContent>
              </Card>
            ))}
          </div>
          <div className="flex flex-wrap justify-between gap-2">
            <Link href="/dashboard" className={buttonVariants({ variant: "ghost" })}>Пропустить</Link>
            <Button onClick={() => go("wizard")}>Подключить VPS <ArrowRight aria-hidden /></Button>
          </div>
        </div>
      ) : (
        <>
          <div className="mx-auto mb-4 max-w-2xl"><Button variant="ghost" size="sm" onClick={() => go("intro")}>← К обзору</Button></div>
          <AddServerWizard />
        </>
      )}
    </>
  );
}
