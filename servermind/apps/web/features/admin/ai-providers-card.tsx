"use client";

import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { useResource } from "@/lib/use-resource";
import { useToast } from "@/lib/toast";
import { formatDateTimeUtc } from "@/lib/format";
import type { AiKey, Provider } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CheckboxField } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/input";
import { SecretInput } from "@/components/ui/secret-input";
import { ErrorState, InlineAlert } from "@/components/ui/states";
import { SkeletonBlock } from "@/components/ui/skeleton";

const PROVIDERS: { id: Provider; name: string; note: string }[] = [
  { id: "openai", name: "OpenAI", note: "Официальный API OpenAI" },
  { id: "anthropic", name: "Anthropic (Claude)", note: "Официальный API Anthropic" },
  { id: "deepseek", name: "DeepSeek", note: "Официальный API DeepSeek" },
];

function AddKeyDialog({ provider, open, onOpenChange, onAdded }: { provider: (typeof PROVIDERS)[number] | null; open: boolean; onOpenChange: (o: boolean) => void; onAdded: () => void }) {
  const toast = useToast();
  const [value, setValue] = useState("");
  const [model, setModel] = useState("");
  const [skip, setSkip] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const close = (o: boolean) => { if (!o) { setValue(""); setModel(""); setErr(null); setSkip(false); } onOpenChange(o); };
  const modelOk = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(model.trim());
  const submit = async () => {
    if (!provider) return;
    setBusy(true); setErr(null);
    const r = await api.admin.addAiKey({ provider: provider.id, key: value.trim(), model: model.trim(), skipValidation: skip });
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
          <Field label="Модель" hint="Точное имя модели из документации провайдера. Список моделей у провайдеров меняется, поэтому мы его не подставляем.">
            {(p) => <Input {...p} value={model} onChange={(e) => setModel(e.target.value)} placeholder="имя модели" autoCapitalize="off" spellCheck={false} required />}
          </Field>
          <InlineAlert tone="warning" title="Проверка ключа обращается к провайдеру">
            Проверка запрашивает у провайдера список моделей (обычно не тарифицируется, но условия определяет провайдер). Её можно пропустить: тогда ключ проверится при первом запросе.
          </InlineAlert>
          <CheckboxField checked={skip} onCheckedChange={(v) => setSkip(v === true)} label="Пропустить проверку ключа" />
          <DialogFooter className="-mx-5 -mb-5 mt-2">
            <Button type="button" variant="ghost" onClick={() => close(false)}>Отмена</Button>
            <Button type="submit" loading={busy} disabled={value.trim().length < 12 || !modelOk}>Подключить</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function AiProvidersCard() {
  const toast = useToast();
  const keys = useResource(() => api.admin.aiKeys(), []);
  const [adding, setAdding] = useState<(typeof PROVIDERS)[number] | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const keyList = keys.state.status === "ready" ? keys.state.data : [];
  const keyFor = (p: Provider) => keyList.find((k) => k.provider === p);
  const subscription = keyList.find((k) => k.provider === "chatgpt");

  const remove = async (key: AiKey) => {
    setRemoving(key.id);
    const result = await api.admin.deleteAiKey(key.id);
    setRemoving(null);
    if (!result.ok) {
      toast.push({ tone: "error", title: "Не удалось отключить", description: result.message });
      return;
    }
    toast.push(result.data.revoked === false
      ? { tone: "warning", title: "Аккаунт отключён в ServerMind", description: "Отзыв у OpenAI не подтверждён. Доступ можно отозвать в настройках ChatGPT." }
      : { tone: "info", title: key.provider === "chatgpt" ? "Аккаунт отключён" : "Ключ удалён" });
    void keys.reload();
  };

  return (
    <Card id="ai-providers" className="xl:col-span-2">
      <CardHeader>
        <div>
          <CardTitle>Подключение AI</CardTitle>
          <CardDescription className="mt-1">Настройте ключ провайдера или подключите подписку ChatGPT к своему аккаунту ServerMind.</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <h3>API-ключи</h3>
        {keys.state.status === "loading" && <SkeletonBlock className="h-40 rounded-card" />}
        {keys.state.status === "error" && <ErrorState compact code={keys.state.code} message={keys.state.message} onRetry={keys.reload} />}
        {keys.state.status === "ready" && (
          <ul className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
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
                      <Button variant="secondary" size="sm" loading={removing === k.id} onClick={() => void remove(k)}><Trash2 aria-hidden /> Удалить ключ</Button>
                    </>
                  ) : (
                    <Button variant="secondary" onClick={() => setAdding(p)}><Plus aria-hidden /> Подключить</Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <section className="space-y-3 rounded-card border border-stroke p-5" aria-labelledby="chatgpt-plan">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 id="chatgpt-plan">Подписка ChatGPT</h3>
            {keys.state.status === "ready" && (
              <Badge tone={subscription?.status === "valid" ? "success" : subscription ? "danger" : "neutral"}>
                {subscription?.status === "valid" ? "Аккаунт подключён" : subscription ? "Требуется повторный вход" : "Не подключена"}
              </Badge>
            )}
          </div>
          <p className="text-sm text-text-secondary">
            Подключение проходит через официальный вход OpenAI и перенос авторизации по SSH. Подписку использует только подключивший её владелец в режиме собственных подключений.
          </p>
          {subscription && (
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-sm text-text-secondary">{subscription.masked} · {subscription.model}</span>
              <Button variant="secondary" size="sm" loading={removing === subscription.id} onClick={() => void remove(subscription)}>Отключить аккаунт</Button>
            </div>
          )}
          <a className="text-sm font-medium text-primary underline underline-offset-4" href="https://github.com/foecerip2/Test/blob/main/servermind/docs/operations/ai-connections.md" target="_blank" rel="noreferrer">
            Как войти и подключить аккаунт ChatGPT
          </a>
          <p className="text-xs text-text-muted">Claude и DeepSeek подключаются через API-ключи.</p>
        </section>
      </CardContent>
      <AddKeyDialog provider={adding} open={adding != null} onOpenChange={(open) => { if (!open) setAdding(null); }} onAdded={() => void keys.reload()} />
    </Card>
  );
}
