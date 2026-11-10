# LeadHunter AI — обязательная инструкция для Claude

> Этот документ — инструкция по превращению визуального прототипа в production-ready MVP. Совместно прочитать `PRODUCT_TZ_REFERENCE.md`, `DESIGN_SYSTEM.md`, `README.md`, а затем исходники `index.html`, `assets/styles.css`, `assets/app.js`.

## 0. Роль и конечная цель
Ты — tech lead, product designer, full-stack engineer и специалист по безопасной эксплуатации. Создай ПРИВАТНОЕ приложение LeadHunter AI для одного владельца, ориентированное на поиск автосервисов по всей России, скоринг, персональные черновики, ручное согласование и законный контроль коммуникаций. Второй проект AutoFlow пока не создавай, кроме передачи заинтересованной компании в CRM и ссылки на будущий продукт. Дизайн должен иметь вид дорого выполненного заказного B2B SaaS, а не шаблона AI.

## 1. Приоритет источников истины
1. Закон и безопасность, ограничения каналов и провайдеров.
2. `PRODUCT_TZ_REFERENCE.md` — функциональные и инфраструктурные требования.
3. `DESIGN_SYSTEM.md` — визуальные требования и запреты.
4. Рабочий прототип — интерактивный UX-референс (не архитектура production).
5. Новые решения согласовывать, не переписывать уже работающие части проекта.

## 2. Входные условия
- 3 VPS приблизительно 2 vCPU / 4 GB RAM / 40 GB SSD, Ubuntu. Для первого этапа нужны только два; третий резервировать для AutoFlow.
- Бюджет до 10 000 ₽. Никаких платных лицензий и услуг без предварительного письменного согласования.
- Владелец — физическое лицо; не предполагать ИП, ООО и разрешённый доступ к MAX Business API.
- Поиск — вся Россия, ограниченные очереди / батчи, разумный rate limiting, TTL данных, соблюдение robots/ToS/лицензий источников.
- AI — опциональная абстракция: no-AI/rules, официальный API-ключ, только поддерживаемый OAuth/авторизация если такой способ официально доступен для SDK/API. Обычная платная подписка ChatGPT/Claude ≠ API. Не делать cookie scraping, browser login automation, reverse-engineering chat UI.
- Интерфейс на русском, mobile first, доступ с телефона и desktop.
- Макет полностью демонстрационный; без реальных внешних запросов и отправки.

## 3. Непереговорные безопасность и комплаенс
- Согласование владельцем текста отдельно от согласия адресата. Автоматическое рекламное сообщение только с подтверждённым допустимым основанием и поддержкой API канала.
- `send_permission` deny-by-default. Сохранять источник, дату/время, метод и scope согласия, revocation и доказательство; при отказе — permanent suppression пока не появится новое законное основание.
- Не автоматизировать холодные массовые сообщения, спам в личные мессенджеры, обход капчи, TOS/лимитов, фейковые аккаунты, подмену личности.
- Для неподдерживаемого канала — подготовленный черновик для ручного действия, без ложных обещаний автоматической синхронизации ответов.
- Персональные данные: минимизация, сроки хранения, удаление, права субъекта, выяснение обязанностей оператора и соответствия РФ 152-ФЗ до реальных контактов. Не включать реальные ПД в логи.
- Не открывать БД/Redis в публичный интернет; SSH ключи, отдельный системный пользователь, firewall, WireGuard, секреты из env/secrets manager, бэкапы и восстановление.
- Сканирование сайтов: SSRF защита (DNS rebinding, частные/loopback/link-local/metadata IP, redirect), ограничение размера, content type, таймауты, rate limits, robots/ToS, allowlist портов, без выполнения JS по умолчанию.
- CI не развёртывает в production до зелёных тестов и healthcheck. Atomic deploy/rollback. Никаких delete/reinstall существующих сервисов без разрешения.

## 4. Рекомендованный стек
- Frontend Next.js App Router + TypeScript + React, CSS variables + собственные компоненты (либо Tailwind c явными дизайн-токенами, но без generic UI kit look).
- Backend Python FastAPI + Pydantic + SQLAlchemy + Alembic.
- PostgreSQL 16+; Redis для брокера/короткого кэша; Celery worker (либо более лёгкая очередь при ограничениях VPS), опционально APScheduler для задач по расписанию.
- HTTPX/BeautifulSoup для разрешённых страниц; Playwright только при крайней необходимости и разумных ресурсах.
- AI `ProviderAdapter` with `DisabledProvider`, `OpenAICompatibleProvider`, `OfficialOAuthProvider` ONLY when officially supported; budget limits, redaction, retries, structured output validation, versioned prompts.
- Channels: Email (OAuth/IMAP, SMTP при правомерной отправке), MAX/VK/Telegram как будущие адаптеры после доступов; webhook signature validation, deduplication, rate limiting, idempotency.
- Nginx + HTTPS, Docker Compose, GitHub Actions.

## 5. Монорепозиторий
```text
leadhunter/
├── apps/web/                  # Next.js, страницы и компоненты из дизайн-системы
├── apps/api/                  # FastAPI, REST, RBAC(single admin), сервисы
├── workers/discovery/         # поисковые задачи и источники
├── workers/site_analysis/     # безопасная проверка сайтов
├── workers/ai/                # провайдеры и промпты
├── integrations/sources/      # CSV, разрешённые источники
├── integrations/channels/     # email и будущие каналы
├── packages/contracts/        # схемы API, статусы, event contracts
├── infra/docker/              # compose, healthchecks, resources
├── infra/nginx/               # TLS/reverse proxy
├── infra/wireguard/           # приватная сеть (без ключей в git)
├── .github/workflows/         # lint/test/build/deploy-gated
├── docs/                      # ADR, runbooks, guides
└── tests/                     # frontend/backend/integration/security
```

## 6. Таблицы (минимум)
- `users(id, email, password_hash, totp_secret_encrypted?, created_at)`
- `companies(id, legal_name, public_name, city, region, category, website, canonical_domain, status, created_at, updated_at)`
- `source_records(id, company_id, source_type, source_url, license_tag, fetched_at, expires_at, evidence_excerpt, fingerprint)`
- `company_facts(id, company_id, source_record_id, field_name, value_json, confidence, verification_state, checked_at)`
- `lead_scores(id, company_id, score, model_version, reasons_json, created_at)`
- `contacts(id, company_id, channel_type, contact_value_encrypted, is_business_contact, last_verified_at)`
- `consents(id, contact_id, channel_type, scope, proof_type, proof_reference, granted_at, revoked_at, expires_at)`
- `suppression_list(id, contact_fingerprint, scope, reason, created_at)`
- `drafts(id, company_id, contact_id, channel_type, body, prompt_version, source_fact_ids_json, status, created_at)`
- `approvals(id, draft_id, approved_by, approved_at, approved_body_hash, decision, notes)`
- `outbound_messages(id, draft_id, contact_id, channel_type, idempotency_key, permission_snapshot_id, status, provider_message_id, sent_at, error_code)`
- `conversations(id, company_id, contact_id, channel_type, external_thread_id, stage, last_message_at)`
- `messages(id, conversation_id, direction, body_encrypted, received_at, channel_message_id, classification, confidence)`
- `tasks(id, company_id, title, due_at, status, owner_id)`
- `jobs(id, type, payload_json, state, retries, last_error, created_at, updated_at)`
- `audit_logs(id, actor_id, action, object_type, object_id, meta_json, timestamp)`
Migration, indices, uniqueness by canonical domain + city where reasonable; never dedupe solely by name.

## 7. API contracts
- `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`, `POST /api/auth/2fa/verify` (optional later)
- `GET/POST /api/jobs`, `GET /api/jobs/{id}`, `POST /api/jobs/{id}/cancel`
- `GET /api/companies?query=&city=&score_min=&status=&cursor=`; `GET/PATCH /api/companies/{id}`
- `GET /api/companies/{id}/evidence`, `GET /api/companies/{id}/score`
- `POST /api/drafts/generate`, `GET /api/drafts`, `PATCH /api/drafts/{id}`, `POST /api/drafts/{id}/approve`, `POST /api/drafts/{id}/reject`
- `POST /api/messages/{draft_id}/send` => transactional permission check, atomic approved-hash check, idempotency; 403 if no permission, 409 if stale approval
- `GET /api/conversations`, `GET /api/conversations/{id}/messages`, `POST /api/conversations/{id}/classify`
- `POST /api/integrations/{provider}/webhook` => signature, deduplication, safe body limits
- `GET /api/analytics/summary`, `GET /api/audit`, `GET /healthz`, `GET /readyz`
Specify Pydantic schemas and error envelopes before implementation. Enforce authn/authz on every business endpoint.

## 8. Workers and task graph
`discover_companies → normalize → deduplicate → check_source_permissions → fetch_public_site → extract_evidence → score_company → generate_draft_optional → queue_for_approval`.
Separate inbound path: `receive_webhook_or_email → verify_sender + dedup → persist_encrypted → classify_optional → update_pipeline → notify_admin`.
Separate outgoing path: `approved_draft + consent_proof + allowed_channel → transactional permission check → queued_once → provider_send → reconcile_receipt`; no consent => `blocked` and no attempt.
Retry external failures with bounded exponential backoff; distinguish permanent errors. Never retry a confirmed opt-out.

## 9. Production UX acceptance
- Eight routes `/overview`, `/discovery`, `/companies`, `/approvals`, `/inbox`, `/pipeline`, `/analytics`, `/settings`.
- Match visual language of prototype: warm neutral backgrounds, ink typography, muted emerald CTA, fine borders, dense but legible information, strong grid, no AI-slop.
- On mobile 360/390px: menus, forms, detail, consent warning and navigation usable without clipping; scroll tables intentionally.
- All buttons operational or disabled with an explanation. Loading, empty, error, permission-denied, no AI, offline states.
- Every number is computed from backend, never hard-coded demo metrics in production.
- Approvals require explicit confirmation and must display consent status. Message cannot send if approved content changed without reapproval.
- At least WCAG AA for text/interactive elements; keyboard, focus and reduced-motion support.

## 10. Testing gates
- Unit: normalization, city parsing, scoring rules, draft hash, consent state, suppression, state transitions, idempotency.
- Integration: CSV import, source evidence persistence, API auth, job replay, message webhook dedup, outbound permission checks.
- Security: SSRF private IP/redirect/DNS rebinding, webhook signature, CSRF/session security, XSS escaped content, rate limiting, secret leakage, SQL injection baseline.
- E2E Playwright: sign in, company listing/filter, evidence, edit/approve draft, blocked send absent consent, inbox classification, mobile menu.
- Ops: Docker restart, backup restore, DB migrations rollback path, worker crash, redis outage, health/readiness, deploy rollback.
- Formal acceptance: no sending without verified permission; opt-out blocks subsequent send; no source without license policy; no secrets committed; UI matches screenshots where appropriate; no production demo data.

## 11. CI/CD and VPS layout
- VPS1: Nginx/TLS, web, API, Postgres, Redis restricted; keep resource memory budgets, log rotation and disk space alerts.
- VPS2: worker(s), capped concurrency (start 1–2), low-memory crawler, outbound egress restrictions, WireGuard tunnel to VPS1.
- VPS3: reserve for future AutoFlow; do not deploy LeadHunter there unless user requests.
- Private GitHub repo. CI: lint → types → unit → integration → build → security audit → deploy to staging/manual approval → deploy verified digest → healthcheck/rollback.
- Deploy through separate least-privilege user and pinned image digest. No root remote arbitrary shell, no automatic deploy on unreviewed branches.
- Offsite encrypted backup, retention, periodic restore test. Ensure no backup contains secrets in plain text.

## 12. Порядок реализации; НЕ перепрыгивать
**Фаза 0 — аудит и проектирование:** прочитать документы; проверить VPS ресурсы, ОС, DNS, репозиторий, существующие приложения; риски, ADR; ничего не устанавливать без согласования.
**Фаза 1 — frontend foundation:** Next.js UI из дизайна, адаптивность, состояния и mock provider. Приложить скриншоты desktop/mobile.
**Фаза 2 — backend & data:** PostgreSQL, migrations, auth, companies, evidence, CSV, API integration.
**Фаза 3 — discovery:** безопасные источники, задания, workers, scoring, dedup. Лимиты бюджета.
**Фаза 4 — AI optional:** no-AI mode + официальный provider; генерировать черновики с цитированием доказательств.
**Фаза 5 — approval & CRM:** одобрение, ограничения отправки, email allowed replies, классификация, opt-out.
**Фаза 6 — deploy/QA:** CI/CD, backup, health, security/e2e, acceptance. Только после разрешения production deploy.

В каждой фазе: (1) цель; (2) затронутые файлы; (3) код; (4) команды проверки; (5) вывод тестов; (6) скриншоты/артефакты; (7) риски; (8) следующий шаг. Если реальный код недоступен — не симулируй результаты.

## 13. Фазовые промпты для Claude

### Промпт 0 (начало)
Изучи все файлы пакета, включая PRODUCT_TZ_REFERENCE.md, DESIGN_SYSTEM.md и интерактивный макет. Подготовь gap analysis и ADR. Не меняй серверы и не устанавливай пакеты. Перечисли минимально необходимые безопасные доступы. Оцени 2 VPS для LeadHunter и третий в резерве. Дай пофайловый план.

### Промпт 1 (UI)
Реализуй Next.js App Router + TypeScript UI по дизайну. Все восемь разделов, модульные компоненты, чистый layout, responsive desktop/mobile, mock API adapter. Не используй generic shadcn template без кастомизации. Сделай скриншоты desktop/mobile готового UI, сравни с интерактивным прототипом и исправь отклонения. Реализуй loading/empty/error states.

### Промпт 2 (API)
Реализуй FastAPI, SQLAlchemy, Alembic, PostgreSQL, безопасную сессию администратора и REST contracts из ТЗ. Добавь CSV импорт и дедуп, evidence, фильтры. Сначала схемы и тесты; затем endpoints. Подключи UI вместо mock data без потери дизайна.

### Промпт 3 (Discovery)
Реализуй ограниченный crawler разрешённых сайтов, source policy registry, SSRF и rate limiting, очередь задач, отмену, retries. Добавь rule-based scoring, подтверждение фактов. Без обхода капчи и массовой загрузки запрещённых источников.

### Промпт 4 (AI)
Реализуй AI provider interface с disabled mode и официальным API adapter. Не делай login automation для подписок ChatGPT/Claude. AI JSON-вывод должен проходить schema validation; каждое индивидуальное утверждение в черновике связано с evidence. Учти лимиты денег и токенов.

### Промпт 5 (Messaging)
Реализуй approval state machine + content hashes + consent evidence + suppression list + идемпотентную отправку по разрешённым каналам. Подключи безопасное получение email-ответов, если доступ согласован. При отсутствии согласия автоматическая отправка заблокирована.

### Промпт 6 (Deploy)
Собери Docker Compose для VPS1/VPS2, WireGuard, Nginx HTTPS, healthcheck/readiness, backups, GitHub CI/CD с ручным promotion и rollback. Проведи тесты и подготовь runbook. Не изменяй существующие приложения без согласования.

## 14. Критерий успеха MVP
Рабочая end-to-end цепочка: импорт/разрешённый поиск → доказательства → скоринг → черновик → согласование → безопасный разрешённый канал/ручной контакт → полученный ответ → статус CRM. На мобильном устройстве это можно пройти без ПК. Нет выдуманной статистики, нет автоматического спама, нет опасного доступа к серверу и нет необоснованных платных зависимостей.
