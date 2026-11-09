# SECURITY и threat model (v0, Фаза 0)

Принципы: AI — недоверенный планировщик; никаких произвольных shell-команд; least privilege; честные статусы; никаких секретов в чате, git, логах, prompts, browser storage.

## Границы доверия

1. Browser — недоверенный. CSRF + HttpOnly/Secure/SameSite cookie (Фаза 2).
2. API — авторизация + проверка `organization_id` на каждом ресурсе (IDOR-тесты).
3. LLM — недоверенный вывод; логи серверов — потенциальный prompt injection.
4. Worker — единственный исполнитель; только каталог одобренных tools.
5. Целевой VPS принадлежит клиенту; отдельный пользователь `servermind` без docker group и без безусловного sudo.

## Угрозы и меры

| Угроза | Мера | Статус |
|---|---|---|
| IDOR / подмена organization_id | tenant-фильтр + тесты | запланировано (Ф2) |
| MITM по SSH | host-key pinning, подтверждение fingerprint, без `StrictHostKeyChecking=no` | запланировано (Ф2) |
| SSRF через hostname | запрет private/loopback/link-local/metadata, DNS re-resolve+pin | запланировано (Ф2) |
| Prompt injection из логов | redaction, caps (500 строк/64 КиБ), маркировка untrusted | запланировано (Ф3) |
| LLM придумывает tool | whitelist + JSON Schema, unknown tool → reject | запланировано (Ф3) |
| Мутация без approval / подмена плана | approval привязан к (actor, plan_id, revision, hash, server, expiry); worker перепроверяет | запланировано (Ф3–4) |
| Утечка ключей | AEAD, master key вне БД, UI хранит только mask+id | запланировано (Ф2–3) |
| Двойное списание | ledger, idempotency key, unique index, check ≥ 0 | запланировано (Ф5) |
| Эскалация на целевом VPS | manual bootstrap / manual-only до security review | политика действует сейчас |
| Kill switch | `EXECUTION_ENABLED=false` в API и worker | запланировано (Ф4) |

## Реализовано в web (Фаза 1)

- Нет полей root-пароля; секретные поля (`SecretInput`) держат значение только в памяти компонента, не в `localStorage`.
- Заголовки безопасности (CSP, X-Frame-Options, Referrer-Policy и др.) в `next.config.ts`.
- Dev-фикстуры отделены и всегда помечены ribbon «Демо-данные».
- SSH-кода в репозитории нет: на серверах ничего не выполняется.

## Ограничения

Реальной аутентификации, шифрования, SSH, policy engine и очереди пока **нет**. В режиме fixtures поток «подтвердить → выполнение» — демонстрация и помечен как демо.
