/** Контракты UI ↔ API. В Фазе 2 заменяются сгенерированными из OpenAPI (packages/contracts). */
import type { ImportRow } from "../normalize";
import type { ScoreReason } from "../scoring";

export type { ImportRow, ScoreReason };

export type Channel = "email" | "max" | "vk" | "telegram" | "phone";
export type Tone = "neutral" | "green" | "amber" | "red";

export interface DisplayStatus { key: string; label: string; tone: Tone }

export type CrmStage = "new" | "contacted" | "replied" | "interested" | "pilot" | "lost";
export type CompanyState = "discovered" | "verified" | "scored" | "shortlisted" | "rejected" | "archived";

export interface Company {
  id: string;
  name: string;
  city: string;
  category: string;
  website: string | null;
  domain: string | null;
  state: CompanyState;
  stage: CrmStage;
  score: number;
  display: DisplayStatus;
  sourceLabel: string;
  updatedAt: string;
  demo: boolean;
  /** Только с сервера: возможный дубликат (проверить вручную). */
  duplicateCandidate?: boolean;
}

export interface Fact {
  id: string;
  text: string;
  /** confirmed — есть выдержка и ссылка; hypothesis — вывод, требует проверки */
  kind: "confirmed" | "hypothesis";
  evidenceUrl: string | null;
  evidenceExcerpt: string | null;
  observedAt: string;
  confidence: number;
}

export type ConsentState = "unknown" | "verified" | "denied" | "withdrawn" | "expired";
export interface Consent {
  id: string;
  state: ConsentState;
  purpose: string;
  proofType: string | null;
  proofRef: string | null;
  collectedAt: string | null;
  withdrawnAt: string | null;
}
export interface Contact {
  id: string;
  channel: Channel;
  valueMasked: string;
  role: string;
  legalBasis: string;
  lastVerifiedAt: string | null;
  consent: Consent;
  suppressed: boolean;
  platformAllowed: boolean;
}

export interface ActivityEvent { id: string; icon: string; title: string; text: string; at: string; companyId?: string; companyName?: string | null }

export interface CompanyDetail extends Company {
  facts: Fact[];
  scoreReasons: ScoreReason[];
  scoreVersion: string;
  contacts: Contact[];
  history: ActivityEvent[];
  draftId: string | null;
  note: string;
}

export interface CompanyFilter {
  query?: string;
  city?: string;
  scoreMin?: number;
  status?: string;
  sort?: "score" | "name" | "updated";
  dir?: "asc" | "desc";
  limit?: number;
  /** Непрозрачный курсор следующей страницы (nextCursor предыдущего ответа). */
  cursor?: string;
}
export interface CompanyPage { items: Company[]; total: number; cities: string[]; hasMore: boolean; nextCursor: string | null }

export type DraftStatus = "generated" | "editing" | "pending_review" | "approved" | "rejected";
export interface Draft {
  id: string;
  companyId: string;
  companyName: string;
  city: string;
  score: number;
  channel: Channel;
  subject: string;
  body: string;
  version: number;
  status: DraftStatus;
  promptVersion: string;
  generator: "template" | "ai";
  factIds: string[];
  approvedHash: string | null;
  currentHash: string;
  /** одобрение устарело: текст изменён после согласования */
  approvalStale: boolean;
  updatedAt: string;
}

export type ReasonCode =
  | "EMERGENCY_STOP" | "TEXT_NOT_APPROVED" | "APPROVAL_STALE" | "CONSENT_NOT_VERIFIED"
  | "CONSENT_WITHDRAWN" | "SUPPRESSED" | "CHANNEL_NOT_SUPPORTED" | "NO_CONTACT" | "ALREADY_QUEUED";

export interface OutboxPreview {
  draftId: string;
  channel: Channel;
  contactId: string | null;
  recipientVerified: boolean;
  ownerApproved: boolean;
  consentState: ConsentState;
  platformAllowed: boolean;
  suppressed: boolean;
  emergencyStop: boolean;
  canSend: boolean;
  reasonCodes: ReasonCode[];
  nextAction: "record_consent" | "approve_text" | "manual_contact" | "enable_sending" | "none";
}

export type ConversationStage = "new" | "replied" | "interested" | "question" | "later" | "not_interested" | "unsubscribe" | "wrong_contact" | "ambiguous" | "closed";
export interface Conversation {
  id: string;
  companyId: string;
  companyName: string;
  channel: Channel;
  stage: ConversationStage;
  lastMessageAt: string;
  unread: boolean;
  preview: string;
}
export interface Message {
  id: string;
  direction: "in" | "out";
  body: string;
  at: string;
  classification: { label: ConversationStage; confidence: number; by: "rules" | "manual" } | null;
}

export type TaskType = "follow_up" | "demo" | "call" | "manual_contact";
export interface Task { id: string; companyId: string | null; companyName: string | null; title: string; type: TaskType; status: "open" | "done"; dueAt: string; priority: "low" | "normal" | "high" }

export interface Campaign { id: string; name: string; regions: string[]; categories: string[]; sourceId: string; status: "running" | "paused" | "done"; perDayLimit: number; createdAt: string; progress: { done: number; total: number } }
export interface Job { id: string; label: string; type: "discover" | "enrich" | "score" | "import"; state: "queued" | "running" | "succeeded" | "failed" | "cancelled"; retries: number; lastError: string | null; createdAt: string; updatedAt: string }
export interface SourceConfig { id: string; name: string; kind: "csv" | "catalog"; enabled: boolean; licensePolicy: string; disabledReason: string | null }

export interface SuppressionEntry { id: string; channel: Channel; endpointMasked: string; reason: string; createdAt: string }
export interface AuditEntry { id: string; action: string; entity: string; entityId: string; actor: string; at: string; meta: string }

export interface Settings {
  aiMode: "none" | "api" | "manual";
  aiDailyBudgetRub: number;
  aiMonthlyBudgetRub: number;
  aiSpentTodayRub: number;
  aiSpentMonthRub: number;
  emergencyStopSend: boolean;
  scoreThreshold: number;
  retentionDays: number;
}

export type PilotStatus = "new" | "contacted" | "accepted" | "declined" | "spam";
export interface PilotRequest {
  id: string; businessName: string; city: string; contactName: string; phone: string | null; email: string | null;
  status: PilotStatus; note: string; consentAt: string; consentTextVersion: string; createdAt: string; updatedAt: string;
}
export interface PilotPage { items: PilotRequest[]; nextCursor: string | null }
export interface PilotFilter { status?: PilotStatus; cursor?: string; limit?: number }

export interface Summary {
  pilotRequestsNew?: number;
  companiesTotal: number;
  companiesWeek: number;
  suitable: number;
  /** Показатели ниже сервер пока не отдаёт (нет черновиков, диалогов, задач): UI их скрывает, а не рисует нули. */
  awaitingApproval?: number;
  interested?: number;
  unread?: number;
  blockedSends?: number;
  openTasks?: number;
  jobsActive?: number;
  funnel?: { label: string; count: number }[];
  weekly?: { label: string; found: number; passed: number }[];
  quality?: { duplicatesMarked: number; refusals: number; withEvidencePct: number; suppressed: number };
  /** Порог оценки с сервера (live). */
  scoreThreshold?: number;
  /** Количество компаний по стадиям CRM (live, из /dashboard). */
  byStage?: Partial<Record<CrmStage, number>>;
  attention: { id: string; title: string; text: string; href: string; tone: Tone }[];
  recent: ActivityEvent[];
  topCompanies: Company[];
}

export interface ImportSummary { total: number; importable: number; withIssues: number; exact: number; inFile: number; candidates: number }
export interface ImportPreview { rows: ImportRow[]; missingColumns: string[]; summary: ImportSummary }
export interface ImportResult { jobId: string | null; rowsTotal: number; added: number; skipped: number; candidates: number; summary: ImportSummary }

export interface Me { email: string; initials: string; name: string }

export type UserRole = "owner" | "user";
export type UserStatus = "active" | "pending" | "blocked";
export interface AuthUser { id: string; email: string; role: UserRole; status: UserStatus }
/** Пользователь в админ-API (только для owner). Даты — ISO 8601. */
export interface AdminUser { id: string; email: string; role: UserRole; status: UserStatus; createdAt: string; lastLoginAt: string | null }
export interface OtpChallenge { challengeId: string; expiresIn: number; resendIn: number }
export interface OtpVerified { user: AuthUser; isNew: boolean }

export interface ApiErrorDetails { attemptsLeft?: number; retryAfter?: number; requestId?: string; currentStage?: CrmStage; missingColumns?: string[] }

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details: ApiErrorDetails = {}) {
    super(message);
  }
}

export interface Api {
  /** Режим данных: "live" — рабочий сервер (NEXT_PUBLIC_DATA_MODE / AUTH_MODE), "demo" — демонстрационные данные. */
  readonly mode: "demo" | "live";
  subscribe(cb: () => void): () => void;
  /** "live" — сессия на сервере (NEXT_PUBLIC_AUTH_MODE=live); "demo" — демо-вход с кодом 123456. */
  readonly authMode: "demo" | "live";
  auth: {
    requestCode(email: string): Promise<OtpChallenge>;
    verifyCode(challengeId: string, code: string): Promise<OtpVerified>;
    resendCode(challengeId: string): Promise<{ resendIn: number }>;
    me(): Promise<AuthUser | null>;
    logout(): Promise<void>;
  };
  /** Управление пользователями (только owner): GET/POST /api/v1/admin/users. */
  admin: {
    listUsers(): Promise<AdminUser[]>;
    approveUser(id: string): Promise<AdminUser>;
    blockUser(id: string): Promise<AdminUser>;
  };
  pilotRequests: {
    list(filter: PilotFilter): Promise<PilotPage>;
    update(id: string, patch: { status?: PilotStatus; note?: string }): Promise<PilotRequest>;
  };
  summary(): Promise<Summary>;
  companies: {
    list(f: CompanyFilter): Promise<CompanyPage>;
    get(id: string): Promise<CompanyDetail>;
    /** expected — оптимистичная проверка: если стадия на сервере другая, 409 STAGE_CONFLICT. */
    setStage(id: string, stage: CrmStage, expected?: CrmStage): Promise<void>;
    setNote(id: string, note: string): Promise<void>;
    reject(id: string): Promise<void>;
    exportCsv(f: CompanyFilter): Promise<string>;
  };
  imports: {
    /** dry-run: ничего не записывает. Принимает текст CSV (клиент декодирует UTF-8/cp1251). */
    preview(text: string): Promise<ImportPreview>;
    /** Сервер заново разбирает тот же текст и сверяет с базой: клиентским флагам не доверяет. */
    commit(text: string): Promise<ImportResult>;
  };
  campaigns: {
    list(): Promise<Campaign[]>;
    create(input: { name: string; regions: string[]; categories: string[]; sourceId: string; perDayLimit: number }): Promise<Campaign>;
    setStatus(id: string, status: "running" | "paused"): Promise<void>;
  };
  jobs: { list(): Promise<Job[]>; cancel(id: string): Promise<void> };
  sources(): Promise<SourceConfig[]>;
  drafts: {
    list(): Promise<Draft[]>;
    get(id: string): Promise<Draft>;
    generate(companyId: string, channel: Channel): Promise<Draft>;
    update(id: string, patch: { body?: string; channel?: Channel; subject?: string }, expectedVersion: number): Promise<Draft>;
    approve(id: string, expectedVersion: number): Promise<Draft>;
    reject(id: string): Promise<Draft>;
  };
  outbox: {
    preview(draftId: string): Promise<OutboxPreview>;
    send(draftId: string): Promise<{ status: "queued_demo" }>;
  };
  consents: {
    record(contactId: string, input: { proofType: string; proofRef: string }): Promise<void>;
    withdraw(contactId: string): Promise<void>;
  };
  conversations: {
    list(): Promise<Conversation[]>;
    messages(id: string): Promise<Message[]>;
    classify(id: string, label: ConversationStage): Promise<void>;
    markRead(id: string): Promise<void>;
  };
  tasks: {
    list(): Promise<Task[]>;
    create(input: { companyId: string | null; title: string; type: TaskType; dueAt: string; priority: Task["priority"] }): Promise<Task>;
    setStatus(id: string, status: "open" | "done"): Promise<void>;
  };
  suppression(): Promise<SuppressionEntry[]>;
  audit(): Promise<AuditEntry[]>;
  settings: { get(): Promise<Settings>; patch(p: Partial<Settings>): Promise<Settings> };
}
