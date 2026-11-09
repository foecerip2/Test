import { FlaskConical } from "lucide-react";
/** Всегда видимая плашка в режиме dev-фикстур (MD §17). В production-сборке не рендерится и вырезается из бандла. */
export function DemoRibbon() {
  if (process.env.NEXT_PUBLIC_DEV_FIXTURES !== "1") return null;
  return (
    <div
      role="status"
      className="sticky top-0 z-[60] flex h-7 items-center justify-center gap-2 bg-warning px-3 text-[12px] font-semibold leading-none text-canvas"
    >
      <FlaskConical aria-hidden className="size-3.5 shrink-0" />
      <span className="truncate">Демо-данные · dev-фикстуры · на серверах ничего не выполняется</span>
    </div>
  );
}
