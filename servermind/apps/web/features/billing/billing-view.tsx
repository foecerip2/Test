"use client";

import { useState } from "react";
import { KeyRound, Plus, Trash2, Zap } from "lucide-react";
import { api } from "@/lib/api";
import { useResource } from "@/lib/use-resource";
import { useToast } from "@/lib/toast";
import { formatDateTimeUtc, formatNumber } from "@/lib/format";
import type { AiKey, LedgerEntry, Provider } from "@/lib/types";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CheckboxField } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Field } from "@/components/ui/input";
import { SecretInput } from "@/components/ui/secret-input";
import { EmptyState, ErrorState, InlineAlert } from "@/components/ui/states";
import { SkeletonBlock } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip } from "@/components/ui/tooltip";
import { SourceBadge } from "@/features/status";

const PROVIDERS: { id: Provider; name: string; note: string }[] = [
  { id: "openai", name: "OpenAI", note: "Официальный API OpenAI" },
  { id: "anthropic", name: "Anthropic (Claude)", note: "Официальный API Anthropic" },
  { id: "deepseek", name: "DeepSeek", note: "Официальный API DeepSeek" },
];

const KIND: Record<LedgerEntry["kind"], string> = { credit: "Начисление", reserve: "Резерв", capture: "Списание", release: "Возврат резерва", adjustment: "Корректировка" };

function AddKeyDialog({ provider, open, onOpenChange, onAdded }: { provider: (typeof PROVIDERS)[number] | null; open: boolean; onOpenChange: (o: boolean) => void; onAdded: () => void }) {
  const toast = useToast();
  const [value, setValue] = useState("");
  const [skip, setSkip] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const close = (o: boolean) => { if (!o) { setValue(""); setErr(null); setSkip(false); } onOpenChange(o); };
  const submit = async () => {
    if (!provider) return;
    setBusy(true); setErr(null);
    const r = await api.billing.addKey({ provider: provider.id, key: value.trim(), skipValidation: skip });
    setBusy(false);
    if (!r.ok) { setErr(r.message); return; }
    setValue("");
    toast.push({ tone: "success", title: "Ключ подключён", description: "В интерфейсе хранится только маска." });
    onAdded(); close(false);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent title={`Подключить ${provider?.name ?? ""}`} description="Ключ передаётся на сервер по HTTPS и не сохраняется в браузере.">
        <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="space-y-4 p-5">
          <Field label="API-ключ" error={err}>
            {(p) => <SecretInput {...p} value={value} onChange={(e) => setValue(e.target.value)} placeholder="Вставьте ключ" required />}
          </Field>
          <InlineAlert tone="warning" title="Возможна оплата проверки">
            При проверке выполняется минимальный запрос к API провайдера — он может быть тарифицирован на вашем аккаунте. Проверку можно пропустить: тогда ключ проверится при первом запросе.
          </InlineAlert>
          <CheckboxField checked={skip} onCheckedChange={(v) => setSkip(v === true)} label="Пропустить проверку ключа" />
          <DialogFooter className="-mx-5 -mb-5 mt-2">
            <Button type="button" variant="ghost" onClick={() => close(false)}>Отмена</Button>
            <Button type="submit" loading={busy} disabled={value.trim().length < 12}>Подключить</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function BillingView() {
  const toast = useToast();
  const mode = useResource(() => api.billing.getMode(), []);
  const balance = useResource(() => api.billing.balance(), []);
  const ledger = useResource(() => api.billing.ledger(), []);
  const keys = useResource(() => api.billing.keys(), []);
  const [adding, setAdding] = useState<(typeof PROVIDERS)[number] | null>(null);

  const current = mode.state.status === "ready" ? mode.state.data.mode : "credits";
  const bal = balance.state.status === "ready" ? balance.state.data : null;
  const entries = ledger.state.status === "ready" ? ledger.state.data : [];
  const keyList = keys.state.status === "ready" ? keys.state.data : [];
  const keyFor = (p: Provider): AiKey | undefined => keyList.find((k) => k.provider === p);

  const setMode = async (m: "byok" | "credits") => {
    const r = await api.billing.setMode(m);
    if (!r.ok) toast.push({ tone: "error", title: "Не удалось переключить режим", description: r.message });
    void mode.reload();
  };
  const remove = async (k: AiKey) => {
    const r = await api.billing.deleteKey(k.id);
    toast.push(r.ok ? { tone: "info", title: "Ключ удалён" } : { tone: "error", title: "Не удалось удалить", description: r.message });
    void keys.reload();
  };

  return (
    <>
      <PageHeader title="Биллинг и AI" description="Выберите, как оплачиваются запросы к модели: собственным ключом (BYOK) или кредитами ServerMind." />

      {mode.state.status === "error" && <ErrorState className="mb-6" code={mode.state.code} message={mode.state.message} onRetry={() => { void mode.reload(); void balance.reload(); void ledger.reload(); void keys.reload(); }} />}

      {mode.state.status !== "error" && (
        <Tabs value={current} onValueChange={(v) => void setMode(v as "byok" | "credits")}>
          <TabsList aria-label="Режим оплаты AI" className="mb-6">
            <TabsTrigger value="credits"><Zap aria-hidden className="size-4" /> AI-кредиты</TabsTrigger>
            <TabsTrigger value="byok"><KeyRound aria-hidden className="size-4" /> Собственные ключи</TabsTrigger>
          </TabsList>

          <TabsContent value="credits" className="space-y-6">
            <div className="grid gap-5 lg:grid-cols-3">
              <Card className="lg:col-span-2">
                <CardHeader>
                  <div><CardTitle>Баланс кредитов</CardTitle><CardDescription className="mt-1">Платформа вызывает модель своим ключом; перед запросом резервируется, после — списывается фактическая стоимость.</CardDescription></div>
                </CardHeader>
                <CardContent className="space-y-4">
                  {balance.state.status === "loading" && <SkeletonBlock className="h-16 w-48" />}
                  {balance.state.status === "error" && <ErrorState compact code={balance.state.code} message={balance.state.message} onRetry={balance.reload} />}
                  {bal && (
                    <>
                      <div className="flex flex-wrap items-end justify-between gap-4">
                        <div>
                          <p className="label text-text-secondary">Доступно</p>
                          <p className="kpi text-[34px] leading-10">{formatNumber(bal.available)} <span className="text-base font-normal text-text-muted">кредитов</span></p>
                          <p className="mt-1 text-xs text-text-muted">В резерве: {formatNumber(bal.reserved)}{bal.dailyCap != null && ` · лимит в сутки: ${formatNumber(bal.dailyCap)}`}{bal.monthlyCap != null && ` · в месяц: ${formatNumber(bal.monthlyCap)}`}</p>
                        </div>
                        <Tooltip content="Платёжный провайдер не подключён. На закрытой бете кредиты начисляет администратор.">
                          <span tabIndex={0} className="inline-flex"><Button disabled aria-disabled><Plus aria-hidden /> Пополнить · скоро</Button></span>
                        </Tooltip>
                      </div>
                      {bal.available <= 0 && <InlineAlert tone="danger" title="Кредиты закончились">AI-запросы недоступны. Подключите собственный ключ (BYOK) или обратитесь к администратору беты.</InlineAlert>}
                      {bal.available > 0 && bal.available < 200 && <InlineAlert tone="warning" title="Низкий баланс">Кредитов хватит на небольшое число запросов.</InlineAlert>}
                    </>
                  )}
                </CardContent>
              </Card>
              <Card>
                <CardHeader><CardTitle>Цены</CardTitle></CardHeader>
                <CardContent className="space-y-2 text-sm text-text-secondary">
                  <p>Стоимость считается по модели и числу входных/выходных токенов.</p>
                  <p>Точные тарифы фиксируются по прайс-листу провайдера на дату релиза — до этого цены не показываются, чтобы не вводить в заблуждение.</p>
                </CardContent>
              </Card>
            </div>

            <section aria-labelledby="ledger-h">
              <div className="mb-3 flex items-center gap-2"><h2 id="ledger-h">История начислений и списаний</h2></div>
              {ledger.state.status === "loading" && <SkeletonBlock className="h-40 rounded-card" />}
              {ledger.state.status === "error" && <ErrorState compact code={ledger.state.code} message={ledger.state.message} onRetry={ledger.reload} />}
              {ledger.state.status === "ready" && entries.length === 0 && <EmptyState title="Операций по кредитам пока нет" />}
              {entries.length > 0 && (
                <>
                  <div className="hidden overflow-hidden rounded-card border border-stroke md:block">
                    <table className="w-full text-left text-sm">
                      <caption className="sr-only">Леджер кредитов</caption>
                      <thead className="border-b border-stroke bg-elevated text-xs text-text-muted"><tr>
                        <th scope="col" className="px-4 py-3 font-medium">Время</th><th scope="col" className="px-4 py-3 font-medium">Тип</th><th scope="col" className="px-4 py-3 font-medium">Описание</th><th scope="col" className="px-4 py-3 font-medium">Модель / токены</th><th scope="col" className="px-4 py-3 text-right font-medium">Сумма</th>
                      </tr></thead>
                      <tbody className="divide-y divide-stroke bg-surface">
                        {entries.map((e) => (
                          <tr key={e.id}>
                            <td className="tabular whitespace-nowrap px-4 py-3 text-text-secondary">{formatDateTimeUtc(e.at)}</td>
                            <td className="px-4 py-3">{KIND[e.kind]}</td>
                            <td className="px-4 py-3 text-text-secondary">{e.note}</td>
                            <td className="tabular px-4 py-3 text-xs text-text-muted">{e.model ? `${e.model} · ${formatNumber(e.tokensIn ?? 0)} → ${formatNumber(e.tokensOut ?? 0)}` : "—"}</td>
                            <td className={`tabular px-4 py-3 text-right font-medium ${e.amount > 0 ? "text-success" : ""}`}>{e.amount > 0 ? "+" : ""}{formatNumber(e.amount)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <ul className="space-y-3 md:hidden">
                    {entries.map((e) => (
                      <li key={e.id} className="rounded-card border border-stroke bg-surface p-4">
                        <div className="flex items-start justify-between gap-3"><span className="font-medium">{KIND[e.kind]}</span><span className={`tabular font-medium ${e.amount > 0 ? "text-success" : ""}`}>{e.amount > 0 ? "+" : ""}{formatNumber(e.amount)}</span></div>
                        <p className="mt-1 text-sm text-text-secondary">{e.note}</p>
                        <p className="tabular mt-1 text-xs text-text-muted">{formatDateTimeUtc(e.at)}{e.model ? ` · ${e.model}` : ""}</p>
                      </li>
                    ))}
                  </ul>
                  <div className="mt-2"><SourceBadge source={process.env.NEXT_PUBLIC_DEV_FIXTURES === "1" ? "demo" : "ssh"} /></div>
                </>
              )}
            </section>
          </TabsContent>

          <TabsContent value="byok" className="space-y-6">
            <InlineAlert tone="info" title="Ключи хранятся на сервере">Интерфейс показывает только маску ключа. Платформа не начисляет расходы за токены — они оплачиваются на вашем аккаунте у провайдера.</InlineAlert>
            {keys.state.status === "loading" && <SkeletonBlock className="h-40 rounded-card" />}
            {keys.state.status === "error" && <ErrorState compact code={keys.state.code} message={keys.state.message} onRetry={keys.reload} />}
            {keys.state.status === "ready" && (
              <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {PROVIDERS.map((p) => {
                  const k = keyFor(p.id);
                  return (
                    <li key={p.id} className="flex flex-col gap-3 rounded-card border border-stroke bg-surface p-5">
                      <div className="flex items-start justify-between gap-2">
                        <div><h3>{p.name}</h3><p className="text-xs text-text-muted">{p.note}</p></div>
                        {k ? <Badge tone={k.status === "valid" ? "success" : k.status === "invalid" ? "danger" : "neutral"}>{k.status === "valid" ? "Подключён" : k.status === "invalid" ? "Недействителен" : "Не проверен"}</Badge> : <Badge>Не подключён</Badge>}
                      </div>
                      {k ? (
                        <>
                          <p className="font-mono text-sm text-text-secondary" aria-label="Маска ключа">{k.masked}</p>
                          <p className="text-xs text-text-muted">Добавлен {formatDateTimeUtc(k.createdAt)}</p>
                          <Button variant="secondary" size="sm" onClick={() => void remove(k)}><Trash2 aria-hidden /> Удалить ключ</Button>
                        </>
                      ) : (
                        <Button variant="secondary" onClick={() => setAdding(p)}><Plus aria-hidden /> Подключить</Button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="text-sm text-text-muted">Список доступных моделей определяется провайдером после проверки ключа и в этой версии не отображается.</p>
          </TabsContent>
        </Tabs>
      )}

      <AddKeyDialog provider={adding} open={adding != null} onOpenChange={(o) => { if (!o) setAdding(null); }} onAdded={() => void keys.reload()} />
    </>
  );
}
