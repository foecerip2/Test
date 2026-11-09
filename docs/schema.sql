-- «Комбайн» — схема данных (PostgreSQL 15+, расчёт на Supabase).
-- Принципы:
--   * кредиты — целые числа; сумма платежа — в минимальных единицах валюты;
--   * журнал кредитов append-only, баланс хранится отдельно и меняется только функциями;
--   * версия конвейера неизменяема: запуск всегда ссылается на конкретную версию;
--   * владелец данных определяется user_id, права обеспечивает RLS.

create extension if not exists pgcrypto;

-- ───────────────────────── типы ─────────────────────────

create type data_kind        as enum ('text', 'image', 'audio', 'video');
create type run_status       as enum ('queued', 'running', 'succeeded', 'failed', 'canceled');
create type step_status      as enum ('pending', 'queued', 'running', 'succeeded', 'failed', 'skipped', 'canceled');
create type credit_tx_kind   as enum ('purchase', 'bonus', 'run_reserve', 'run_release', 'run_charge', 'refund', 'adjustment');
create type payment_status   as enum ('pending', 'paid', 'failed', 'refunded');
create type visibility_kind  as enum ('private', 'unlisted', 'public');

-- ───────────────────────── пользователи ─────────────────────────

-- Профиль дополняет auth.users (Supabase). Вне Supabase замените ссылку на свою таблицу пользователей.
create table profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  display_name  text,
  is_admin      boolean not null default false,
  is_blocked    boolean not null default false,
  created_at    timestamptz not null default now()
);

-- Баланс. Меняется только функциями add_credits / reserve_credits / charge_step / release_credits.
create table wallets (
  user_id      uuid primary key references profiles (id) on delete cascade,
  balance      integer not null default 0 check (balance >= 0),   -- свободные кредиты
  reserved     integer not null default 0 check (reserved >= 0),  -- заморожены под активные запуски
  updated_at   timestamptz not null default now()
);

-- ───────────────────────── провайдеры и модели ─────────────────────────

create table providers (
  id        text primary key,            -- 'openrouter', 'fal'
  title     text not null,
  is_active boolean not null default true
);

create table models (
  id               uuid primary key default gen_random_uuid(),
  provider_id      text not null references providers (id),
  slug             text not null,                   -- идентификатор у провайдера
  title            text not null,                   -- название в интерфейсе
  input_kinds      data_kind[] not null,
  output_kind      data_kind not null,
  price_unit       text not null,                   -- 'per_call' | 'per_image' | 'per_second' | 'per_1k_tokens'
  credits_per_unit numeric(10, 4) not null check (credits_per_unit >= 0),
  provider_cost_usd_per_unit numeric(12, 6),        -- себестоимость для отчётов о марже
  params_schema    jsonb not null default '{}'::jsonb, -- JSON Schema допустимых параметров
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  unique (provider_id, slug)
);

-- ───────────────────────── конвейеры ─────────────────────────

create table pipelines (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid references profiles (id) on delete cascade, -- null у системных шаблонов
  title       text not null,
  description text,
  is_template boolean not null default false,
  visibility  visibility_kind not null default 'private',
  category    text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index pipelines_owner_idx on pipelines (owner_id);
create index pipelines_template_idx on pipelines (is_template) where is_template;

-- Неизменяемая версия. graph — граф шагов (формат ниже).
create table pipeline_versions (
  id            uuid primary key default gen_random_uuid(),
  pipeline_id   uuid not null references pipelines (id) on delete cascade,
  version       integer not null check (version > 0),
  graph         jsonb not null,
  input_schema  jsonb not null default '{}'::jsonb,   -- какие поля вводит пользователь
  est_credits   integer,                               -- оценка при сохранении
  created_at    timestamptz not null default now(),
  unique (pipeline_id, version)
);

alter table pipelines add column current_version_id uuid references pipeline_versions (id);

-- Формат pipeline_versions.graph:
-- {
--   "nodes": [
--     { "key": "idea",   "type": "input",  "kind": "text" },
--     { "key": "script", "type": "model",  "model_id": "<uuid>", "params": {"style": "short"} },
--     { "key": "images", "type": "model",  "model_id": "<uuid>", "params": {"count": 4, "ratio": "9:16"} },
--     { "key": "voice",  "type": "model",  "model_id": "<uuid>", "params": {"voice": "narrator"} },
--     { "key": "cut",    "type": "model",  "model_id": "<uuid>", "params": {} }
--   ],
--   "edges": [
--     { "from": "idea",   "to": "script" },
--     { "from": "script", "to": "images" },
--     { "from": "script", "to": "voice" },
--     { "from": "images", "to": "cut" },
--     { "from": "voice",  "to": "cut" }
--   ]
-- }
-- Приложение проверяет: граф ацикличен, типы выходов совместимы с входами, все model_id активны.

-- ───────────────────────── запуски ─────────────────────────

create table runs (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references profiles (id) on delete cascade,
  pipeline_version_id  uuid not null references pipeline_versions (id),
  status               run_status not null default 'queued',
  input                jsonb not null default '{}'::jsonb,
  estimated_credits    integer not null check (estimated_credits >= 0),
  reserved_credits     integer not null default 0 check (reserved_credits >= 0),
  charged_credits      integer not null default 0 check (charged_credits >= 0),
  error                text,
  idempotency_key      text,
  created_at           timestamptz not null default now(),
  started_at           timestamptz,
  finished_at          timestamptz,
  unique (user_id, idempotency_key)
);
create index runs_user_created_idx on runs (user_id, created_at desc);
create index runs_active_idx on runs (status) where status in ('queued', 'running');

create table step_runs (
  id                uuid primary key default gen_random_uuid(),
  run_id            uuid not null references runs (id) on delete cascade,
  node_key          text not null,                  -- ключ узла в graph
  model_id          uuid references models (id),
  status            step_status not null default 'pending',
  attempt           integer not null default 0,
  input_refs        jsonb not null default '[]'::jsonb,  -- id активов или значения на входе
  provider_job_id   text,
  credits_estimated integer not null default 0 check (credits_estimated >= 0),
  credits_charged   integer not null default 0 check (credits_charged >= 0),
  provider_cost_usd numeric(12, 6),
  error             text,
  queued_at         timestamptz,
  started_at        timestamptz,
  finished_at       timestamptz,
  unique (run_id, node_key)
);
create index step_runs_run_idx on step_runs (run_id);

-- ───────────────────────── результаты ─────────────────────────

create table assets (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null references profiles (id) on delete cascade,
  run_id        uuid references runs (id) on delete set null,
  step_run_id   uuid references step_runs (id) on delete set null,
  kind          data_kind not null,
  text_content  text,                              -- для kind = 'text'
  storage_path  text,                              -- для файлов
  mime          text,
  bytes         bigint check (bytes is null or bytes >= 0),
  meta          jsonb not null default '{}'::jsonb, -- длительность, размеры, seed и т.д.
  created_at    timestamptz not null default now(),
  expires_at    timestamptz,                       -- срок хранения, затем удаление заданием
  check (
    (kind = 'text' and text_content is not null)
    or (kind <> 'text' and storage_path is not null)
  )
);
create index assets_owner_idx on assets (owner_id, created_at desc);
create index assets_expiry_idx on assets (expires_at) where expires_at is not null;

alter table step_runs add column output_asset_id uuid references assets (id);

-- ───────────────────────── кредиты и оплата ─────────────────────────

create table payments (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references profiles (id) on delete cascade,
  provider        text not null,                    -- платёжный провайдер
  external_id     text not null,                    -- id у провайдера
  amount_minor    integer not null check (amount_minor > 0),
  currency        char(3) not null,
  credits         integer not null check (credits > 0),
  status          payment_status not null default 'pending',
  created_at      timestamptz not null default now(),
  paid_at         timestamptz,
  unique (provider, external_id)
);

-- Журнал append-only. delta > 0 — приход, delta < 0 — расход.
-- idempotency_key защищает от двойной обработки вебхука или повторной доставки задачи.
create table credit_transactions (
  id               bigint generated always as identity primary key,
  user_id          uuid not null references profiles (id) on delete cascade,
  kind             credit_tx_kind not null,
  delta            integer not null,
  run_id           uuid references runs (id),
  step_run_id      uuid references step_runs (id),
  payment_id       uuid references payments (id),
  note             text,
  idempotency_key  text not null,
  created_at       timestamptz not null default now(),
  unique (idempotency_key)
);
create index credit_tx_user_idx on credit_transactions (user_id, created_at desc);

-- ───────────────────────── функции кредитов ─────────────────────────
-- Все функции — security definer: клиент не может менять баланс напрямую.
-- Идемпотентность: повторный вызов с тем же ключом ничего не меняет.

create or replace function add_credits(
  p_user uuid, p_amount integer, p_kind credit_tx_kind, p_key text,
  p_payment uuid default null, p_note text default null
) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_amount <= 0 then raise exception 'amount must be positive'; end if;
  if p_kind not in ('purchase', 'bonus', 'refund', 'adjustment') then
    raise exception 'invalid kind for add_credits';
  end if;

  insert into credit_transactions (user_id, kind, delta, payment_id, note, idempotency_key)
  values (p_user, p_kind, p_amount, p_payment, p_note, p_key)
  on conflict (idempotency_key) do nothing;
  if not found then return; end if;  -- уже обработано

  insert into wallets (user_id, balance) values (p_user, p_amount)
  on conflict (user_id) do update
    set balance = wallets.balance + excluded.balance, updated_at = now();
end $$;

-- Резерв под запуск: переносит кредиты из balance в reserved. Ошибка, если не хватает.
create or replace function reserve_credits(p_run uuid, p_amount integer)
returns void
language plpgsql security definer set search_path = public as $$
declare v_user uuid;
begin
  if p_amount < 0 then raise exception 'amount must not be negative'; end if;
  select user_id into v_user from runs where id = p_run for update;
  if v_user is null then raise exception 'run not found'; end if;

  insert into credit_transactions (user_id, kind, delta, run_id, idempotency_key)
  values (v_user, 'run_reserve', -p_amount, p_run, 'reserve:' || p_run)
  on conflict (idempotency_key) do nothing;
  if not found then return; end if;

  update wallets
     set balance = balance - p_amount, reserved = reserved + p_amount, updated_at = now()
   where user_id = v_user and balance >= p_amount;
  if not found then raise exception 'insufficient credits'; end if;  -- откатывает и запись в журнал

  update runs set reserved_credits = p_amount where id = p_run;
end $$;

-- Списание за выполненный шаг из резерва. Баланс не меняется: резерв уже вычтен из balance.
create or replace function charge_step(p_step uuid, p_amount integer)
returns void
language plpgsql security definer set search_path = public as $$
declare v_run uuid; v_user uuid;
begin
  if p_amount < 0 then raise exception 'amount must not be negative'; end if;
  select run_id into v_run from step_runs where id = p_step for update;
  if v_run is null then raise exception 'step not found'; end if;
  select user_id into v_user from runs where id = v_run for update;

  -- delta = 0: деньги уже ушли в резерв; запись нужна как след и ключ идемпотентности
  insert into credit_transactions (user_id, kind, delta, run_id, step_run_id, note, idempotency_key)
  values (v_user, 'run_charge', 0, v_run, p_step, p_amount::text, 'charge:' || p_step)
  on conflict (idempotency_key) do nothing;
  if not found then return; end if;

  update wallets set reserved = reserved - p_amount, updated_at = now()
   where user_id = v_user and reserved >= p_amount;
  if not found then raise exception 'reserve too small'; end if;

  update step_runs set credits_charged = p_amount where id = p_step;
  update runs set charged_credits = charged_credits + p_amount where id = v_run;
end $$;

-- Возврат неизрасходованного резерва при завершении или отмене запуска.
create or replace function release_credits(p_run uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare v_user uuid; v_left integer;
begin
  select user_id, reserved_credits - charged_credits into v_user, v_left
    from runs where id = p_run for update;
  if v_user is null or v_left <= 0 then return; end if;

  insert into credit_transactions (user_id, kind, delta, run_id, idempotency_key)
  values (v_user, 'run_release', v_left, p_run, 'release:' || p_run)
  on conflict (idempotency_key) do nothing;
  if not found then return; end if;

  update wallets
     set balance = balance + v_left, reserved = reserved - v_left, updated_at = now()
   where user_id = v_user;
end $$;

-- Вызывать функции может только серверный код с сервисным ключом.
revoke all on function add_credits(uuid, integer, credit_tx_kind, text, uuid, text) from public;
revoke all on function reserve_credits(uuid, integer) from public;
revoke all on function charge_step(uuid, integer) from public;
revoke all on function release_credits(uuid) from public;

-- ───────────────────────── защита строк (RLS) ─────────────────────────

alter table profiles             enable row level security;
alter table wallets              enable row level security;
alter table pipelines            enable row level security;
alter table pipeline_versions    enable row level security;
alter table runs                 enable row level security;
alter table step_runs            enable row level security;
alter table assets               enable row level security;
alter table payments             enable row level security;
alter table credit_transactions  enable row level security;
alter table providers            enable row level security;
alter table models               enable row level security;

create policy profiles_own     on profiles  for select using (id = auth.uid());
create policy wallets_own      on wallets   for select using (user_id = auth.uid());
create policy payments_own     on payments  for select using (user_id = auth.uid());
create policy credit_tx_own    on credit_transactions for select using (user_id = auth.uid());

create policy providers_read   on providers for select using (true);
create policy models_read      on models    for select using (is_active);

create policy pipelines_read on pipelines for select
  using (owner_id = auth.uid() or is_template or visibility in ('unlisted', 'public'));
create policy pipelines_write on pipelines for all
  using (owner_id = auth.uid()) with check (owner_id = auth.uid() and not is_template);

create policy versions_read on pipeline_versions for select
  using (exists (select 1 from pipelines p where p.id = pipeline_id
                  and (p.owner_id = auth.uid() or p.is_template or p.visibility in ('unlisted', 'public'))));
create policy versions_insert on pipeline_versions for insert
  with check (exists (select 1 from pipelines p where p.id = pipeline_id and p.owner_id = auth.uid()));

create policy runs_own      on runs      for select using (user_id = auth.uid());
create policy step_runs_own on step_runs for select
  using (exists (select 1 from runs r where r.id = run_id and r.user_id = auth.uid()));
create policy assets_own    on assets    for select using (owner_id = auth.uid());
create policy assets_delete on assets    for delete using (owner_id = auth.uid());

-- Создание запусков, шагов, активов и платежей выполняет серверный код с сервисным ключом;
-- клиентских политик на запись в эти таблицы намеренно нет.

-- ───────────────────────── начальные данные ─────────────────────────

insert into providers (id, title) values
  ('openrouter', 'OpenRouter'),
  ('fal', 'fal.ai')
on conflict do nothing;
