import Link from "next/link";
import { Logo } from "@/components/layout/logo";
import { buttonVariants } from "@/components/ui/button";

export default function NotFound() {
  return (
    <main className="grid min-h-dvh place-items-center px-6">
      <div className="flex max-w-sm flex-col items-center gap-4 text-center">
        <Logo />
        <h1>Страница не найдена</h1>
        <p className="text-text-secondary">Такого адреса нет или у вас нет к нему доступа.</p>
        <Link href="/dashboard" className={buttonVariants()}>На главную</Link>
      </div>
    </main>
  );
}
