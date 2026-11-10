// Доменные типы web-слоя. Контракты с API будут генерироваться из OpenAPI (Фаза 2, packages/contracts).

export type Result<T> =
  | { ok: true; data: T }
  | { ok: false; code: ErrorCode; message: string };

export type ErrorCode =
  | "backend_unavailable"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "validation"
  | "unsupported"
  | "error";

export type ServerStatus = "online" | "offline" | "checking" | "unknown";
export type ServiceState = "active" | "inactive" | "failed" | "unknown";
export type DataSource = "ssh" | "demo";

export interface ServiceInfo {
  name: string;
  state: ServiceState;
  managed: boolean;
}

export interface MetricSample {
  t: string; // ISO-8601 UTC
  cpu: number; // %
  ram: number; // %
  disk: number; // %
}

export interface ServerSummary {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  os: string | null;
  status: ServerStatus;
  lastCheckedAt: string | null; // ISO-8601 UTC
  lastSuccessAt: string | null;
  uptimeSeconds: number | null;
  cpuPercent: number | null;
  ramUsedMb: number | null;
  ramTotalMb: number | null;
  diskUsedGb: number | null;
  diskTotalGb: number | null;
  fingerprint: string;
  services: ServiceInfo[];
  source: DataSource;
}

export type JobStatus =
  | "queued"
  | "validating"
  | "waiting_approval"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "expired"
  | "blocked"; // репетиция остановлена проверкой (исполнитель в режиме «репетиция»)

export type Risk = "R0" | "R1" | "R2" | "R3" | "R4" | "R5";

export type ParamValue = string | number | boolean;

export interface PlanStep {
  id: string;
  tool: string;
  title: string;
  params: Record<string, ParamValue>;
  risk: Risk;
  optional: boolean;
  enabled: boolean;
  expectedChange: string;
  verify: string;
  rollback: string;
}

export type PlanStatus = "waiting_approval" | "approved" | "rejected" | "expired";

export interface ActionPlan {
  id: string;
  serverId: string;
  serverName: string;
  revision: number;
  title: string;
  summary: string;
  steps: PlanStep[];
  downtime: string;
  createdAt: string;
  expiresAt: string;
  canonicalHash: string;
  status: PlanStatus;
  source: DataSource;
}

export interface JobEvent {
  id: string;
  at: string;
  level: "info" | "warn" | "error";
  step?: string;
  message: string;
}

export interface Operation {
  id: string;
  planId: string | null;
  title: string;
  serverId: string;
  serverName: string;
  status: JobStatus;
  risk: Risk;
  actor: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  stepsDone: number;
  stepsTotal: number;
  events: JobEvent[];
  source: DataSource;
  /** "rehearsal": проверки без изменений, на сервер ничего не отправляется. "execute": реальное исполнение обёрткой на сервере. */
  mode?: "rehearsal" | "execute";
}

export interface ToolCall {
  id: string;
  tool: string;
  args: string;
  status: "running" | "done" | "error";
  summary: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  tools?: ToolCall[];
  observed?: string[];
  proposal?: { title: string; steps: string[]; planId: string | null };
  demo?: boolean;
  error?: string;
}

export type Provider = "openai" | "anthropic" | "deepseek";

export interface AiKey {
  id: string;
  provider: Provider | "chatgpt";
  masked: string;
  model?: string;
  createdAt: string;
  status: "valid" | "unchecked" | "invalid";
}

export interface LedgerEntry {
  id: string;
  at: string;
  kind: "credit" | "reserve" | "capture" | "release" | "adjustment";
  amount: number; // целые кредиты (минимальные единицы), со знаком
  note: string;
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
}

export interface Balance {
  available: number;
  reserved: number;
  dailyCap: number | null;
  monthlyCap: number | null;
  /** Только реальный API: настроен ли на сервере ключ платформы и цены (иначе режим кредитов недоступен). */
  creditsConfigured?: boolean;
}

export type DeploymentStatus = "preflight" | "waiting_approval" | "running" | "succeeded" | "failed";

export interface Deployment {
  id: string;
  serverId: string;
  serverName: string;
  template: string;
  domain: string | null;
  status: DeploymentStatus;
  createdAt: string;
  operationId: string | null;
  source: DataSource;
}

export interface AuditEvent {
  id: string;
  at: string;
  actor: string;
  action: string;
  target: string;
}

export interface Invite {
  code: string;
  createdAt: string;
  expiresAt: string;
  usedBy: string | null;
}

/** AI-модель платформы (режим Credits): подключается администратором платформы; ключ наружу не отдаётся — только маска. */
export interface PlatformModel {
  id: string;
  provider: Provider;
  model: string;
  masked: string;
  status: "valid" | "unchecked" | "invalid";
  active: boolean;
  priceIn: number;  // кредитов за 1000 входных токенов (задаёт администратор по прайс-листу провайдера)
  priceOut: number; // кредитов за 1000 выходных токенов
  priceListVersion: string;
  createdAt: string;
}

export interface AdminUser { id: string; email: string; name: string; role: string; active: boolean; createdAt: string | null }

export interface FeatureFlag {
  key: string;
  label: string;
  enabled: boolean;
  description: string;
}

export interface SessionInfo {
  id: string;
  device: string;
  lastActiveAt: string;
  current: boolean;
}

export interface Me {
  id: string;
  email: string;
  name: string;
  role: "owner" | "operator" | "viewer";
  workspace: string;
  twoFactorEnabled: boolean;
}

export interface DeployTemplate {
  id: string;
  name: string;
  description: string;
  available: boolean;
  port: number;
}
