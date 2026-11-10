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

export interface ActivityEvent { id: string; icon: string; title: string; text: string; at: string; companyId?: string }

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
}
export interface CompanyPage { items: Company[]; total: number; cities: string[]; hasMore: boolean }

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
  | "CONSENT_WITHDRAWN" | "SUPPRESSED" | "CHANNEL_NOT_SUPPORTED" | "NO_CONTACT";

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

export interface Summary {
  companiesTotal: number;
  companiesWeek: number;
  suitable: number;
  awaitingApproval: number;
  interested: number;
  unread: number;
  blockedSends: number;
  openTasks: number;
  jobsActive: number;
  funnel: { label: string; count: number }[];
  weekly: { label: string; found: number; passed: number }[];
  quality: { duplicatesMarked: number; refusals: number; withEvidencePct: number; suppressed: number };
  attention: { id: string; title: string; text: string; href: string; tone: Tone }[];
  recent: ActivityEvent[];
  topCompanies: Company[];
}

export interface Me { email: string; initials: string; name: string }

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export interface Api {
  readonly mode: "mock" | "live";
  subscribe(cb: () => void): () => void;
  auth: {
    me(): Promise<Me | null>;
    login(email: string, password: string): Promise<Me>;
    logout(): Promise<void>;
  };
  summary(): Promise<Summary>;
  companies: {
    list(f: CompanyFilter): Promise<CompanyPage>;
    get(id: string): Promise<CompanyDetail>;
    setStage(id: string, stage: CrmStage): Promise<void>;
    setNote(id: string, note: string): Promise<void>;
    reject(id: string): Promise<void>;
    exportCsv(f: CompanyFilter): Promise<string>;
  };
  imports: {
    preview(text: string): Promise<{ rows: ImportRow[]; missingColumns: string[] }>;
    commit(rows: ImportRow[]): Promise<{ added: number; skipped: number }>;
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
