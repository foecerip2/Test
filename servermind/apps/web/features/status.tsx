import { CheckCircle2, CircleSlash, Clock, FlaskConical, Hourglass, Loader2, ShieldAlert, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { DataSource, JobStatus, Risk, ServerStatus, ServiceState } from "@/lib/types";

/** Статус сервера. Пульсация — только в состоянии «проверка». Статус передаётся и текстом, не только цветом. */
export function StatusBadge({ status }: { status: ServerStatus }) {
  const map = {
    online: { tone: "success", label: "Онлайн" },
    offline: { tone: "danger", label: "Недоступен" },
    checking: { tone: "info", label: "Проверка…" },
    unknown: { tone: "neutral", label: "Нет данных" },
  } as const;
  const m = map[status];
  return (
    <Badge tone={m.tone} icon={<i aria-hidden className={`size-2 rounded-full bg-current ${status === "checking" ? "sm-pulse" : ""}`} />}>
      {m.label}
    </Badge>
  );
}

export function ServiceStateBadge({ state }: { state: ServiceState }) {
  const map = {
    active: { tone: "success", label: "active" },
    inactive: { tone: "neutral", label: "inactive" },
    failed: { tone: "danger", label: "failed" },
    unknown: { tone: "neutral", label: "нет данных" },
  } as const;
  const m = map[state];
  return <Badge tone={m.tone}>{m.label}</Badge>;
}

export function JobStatusBadge({ status }: { status: JobStatus }) {
  const map: Record<JobStatus, { tone: "neutral" | "info" | "warning" | "success" | "danger"; label: string; icon: React.ReactNode }> = {
    queued: { tone: "neutral", label: "В очереди", icon: <Hourglass aria-hidden /> },
    validating: { tone: "info", label: "Проверка", icon: <Loader2 aria-hidden className="sm-spin" /> },
    waiting_approval: { tone: "warning", label: "Ждёт подтверждения", icon: <ShieldAlert aria-hidden /> },
    running: { tone: "info", label: "Выполняется", icon: <Loader2 aria-hidden className="sm-spin" /> },
    succeeded: { tone: "success", label: "Выполнено", icon: <CheckCircle2 aria-hidden /> },
    failed: { tone: "danger", label: "Ошибка", icon: <XCircle aria-hidden /> },
    cancelled: { tone: "neutral", label: "Отменено", icon: <CircleSlash aria-hidden /> },
    expired: { tone: "neutral", label: "Истекло", icon: <Clock aria-hidden /> },
  };
  const m = map[status];
  return <Badge tone={m.tone} icon={m.icon}>{m.label}</Badge>;
}

export const RISK_INFO: Record<Risk, { label: string; tone: "neutral" | "info" | "warning" | "danger"; hint: string }> = {
  R0: { label: "R0 · чтение", tone: "neutral", hint: "Только чтение, выполняется автоматически в рамках лимитов." },
  R1: { label: "R1 · чтение", tone: "info", hint: "Безопасная проверка без изменений." },
  R2: { label: "R2 · изменение", tone: "warning", hint: "Изменяет состояние службы. Нужно подтверждение." },
  R3: { label: "R3 · системное", tone: "warning", hint: "Устанавливает пакеты или меняет конфигурацию. Нужно подтверждение." },
  R4: { label: "R4 · запрещено в MVP", tone: "danger", hint: "Выключено в MVP." },
  R5: { label: "R5 · запрещено", tone: "danger", hint: "Удаление данных и массовые изменения запрещены." },
};

export function RiskBadge({ risk }: { risk: Risk }) {
  const r = RISK_INFO[risk];
  return <Badge tone={r.tone} title={r.hint}>{r.label}</Badge>;
}

/** Метка происхождения данных. «Демо» — данные из dev-фикстур. */
export function SourceBadge({ source }: { source: DataSource }) {
  if (source !== "demo") return null;
  return <Badge tone="warning" icon={<FlaskConical aria-hidden />}>Демо</Badge>;
}
