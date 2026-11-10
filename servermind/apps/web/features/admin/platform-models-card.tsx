"use client";

import { useState } from "react";
import { Cpu, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { useResource } from "@/lib/use-resource";
import { useToast } from "@/lib/toast";
import { formatNumber } from "@/lib/format";
import type { PlatformModel, Provider } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CheckboxField } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/input";
import { SecretInput } from "@/components/ui/secret-input";
import { EmptyState, ErrorState, InlineAlert } from "@/components/ui/states";
import { SkeletonBlock } from "@/components/ui/skeleton";

const PROVIDERS: { id: Provider; name: string }[] = [
  { id: "openai", name: "OpenAI" },
  { id: "anthropic", name: "Anthropic (Claude)" },
  { id: "deepseek", name: "DeepSeek" },
];
const STATUS = { valid: { tone: "success", label: "Ключ проверен" }, unchecked: { tone: "neutral", label: "Не проверен" }, invalid: { tone: "danger", label: "Ключ отклонён" } } as const;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

function AddModelDialog({ open, onOpenChange, onAdded }: { open: boolean; onOpenChange: (o: boolean) => void; onAdded: () => void }) {
  const toast = useToast();
  const [provider, setProvider] = useState<Provider>("openai");
  const [model, setModel] = useState("");
  const [key, setKey] = useState("");
  const [priceIn, setPriceIn] = useState("");
  const [priceOut, setPriceOut] = useState("");
  const [version, setVersion] = useState("");
  const [skip, setSkip] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const reset = () => { setModel(""); setKey(""); setPriceIn(""); setPriceOut(""); setVersion(""); setSkip(false); setErr(null); };
  const close = (o: boolean) => { if (!o) reset(); onOpenChange(o); };
  const pin = Number(priceIn), pout = Number(priceOut);
  const valid = MODEL_RE.test(model.trim()) && key.trim().length >= 12 && Number.isInteger(pin) && pin >= 1 && Number.isInteger(pout) && pout >= 1;

  const submit = async () => {
    setBusy(true); setErr(null);
    const r = await api.admin.addModel({ provider, model: model.trim(), key: key.trim(), priceIn: pin, priceOut: pout, priceListVersion: version.trim(), skipValidation: skip });
    setBusy(false);
    if (!r.ok) { setErr(r.message); return; }
    toast.push({ tone: "success", title: "Модель подключена", description: "Ключ зашифрован на сервере; в интерфейсе остаётся только маска." });
    reset(); onAdded(); onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent title="Подключить модель платформы" description="Это ключ ПЛАТФОРМЫ для режима кредитов. Он виден только администратору и не показывается пользователям.">
        <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="space-y-4 p-5">
          <Field label="Провайдер">{(p) => <Select {...p} value={provider} onChange={(e) => setProvider(e.target.value as Provider)}>{PROVIDERS.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>}</Field>
          <Field label="Модель" hint="Точное имя из документации провайдера.">{(p) => <Input {...p} value={model} onChange={(e) => setModel(e.target.value)} placeholder="имя модели" autoCapitalize="off" spellCheck={false} required />}</Field>
          <Field label="API-ключ платформы" error={err}>{(p) => <SecretInput {...p} value={key} onChange={(e) => setKey(e.target.value)} placeholder="Вставьте ключ" required />}</Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Цена входа, кредитов / 1000 токенов" hint="Целое ≥ 1. По прайс-листу провайдера.">{(p) => <Input {...p} inputMode="numeric" value={priceIn} onChange={(e) => setPriceIn(e.target.value.replace(/\D/g, ""))} required />}</Field>
            <Field label="Цена выхода, кредитов / 1000 токенов" hint="Целое ≥ 1.">{(p) => <Input {...p} inputMode="numeric" value={priceOut} onChange={(e) => setPriceOut(e.target.value.replace(/\D/g, ""))} required />}</Field>
          </div>
          <Field label="Версия прайс-листа (необязательно)" hint="Например, 2026-11. Попадёт в каждую проводку списания.">{(p) => <Input {...p} value={version} maxLength={40} onChange={(e) => setVersion(e.target.value)} />}</Field>
          <InlineAlert tone="info" title="Только официальный API">
            Подключается ключ официального API провайдера. Вход по логину подписки ChatGPT/Claude не поддерживается: он нарушает условия сервисов.
          </InlineAlert>
          <CheckboxField checked={skip} onCheckedChange={(v) => setSkip(v === true)} label="Пропустить проверку ключа (проверка запрашивает у провайдера список моделей)" />
          <DialogFooter className="-mx-5 -mb-5 mt-2">
            <Button type="button" variant="ghost" onClick={() => close(false)}>Отмена</Button>
            <Button type="submit" loading={busy} disabled={!valid}>Подключить</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function PlatformModelsCard() {
  const toast = useToast();
  const list = useResource(() => api.admin.models(), []);
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const act = async (m: PlatformModel, what: "activate" | "check" | "delete") => {
    setBusyId(m.id);
    const r = what === "activate" ? await api.admin.activateModel(m.id) : what === "check" ? await api.admin.checkModel(m.id) : await api.admin.deleteModel(m.id);
    setBusyId(null);
    if (!r.ok) toast.push({ tone: "error", title: "Не удалось выполнить действие", description: r.message });
    else toast.push({ tone: "success", title: what === "activate" ? "Модель активирована" : what === "check" ? "Ключ проверен" : "Модель удалена" });
    void list.reload();
  };

  const data = list.state.status === "ready" ? list.state.data : null;
  return (
    <Card className="xl:col-span-2">
      <CardHeader>
        <div>
          <CardTitle className="flex items-center gap-2"><Cpu aria-hidden className="size-4 text-primary" /> AI-модели платформы</CardTitle>
          <CardDescription className="mt-1">Модель для режима кредитов подключается здесь, только администратором платформы. Ключ шифруется на сервере, пользователям не показывается.</CardDescription>
        </div>
        <Button size="sm" variant="secondary" onClick={() => setOpen(true)}><Plus aria-hidden /> Подключить модель</Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {list.state.status === "loading" && <SkeletonBlock className="h-16 rounded-card" />}
        {list.state.status === "error" && (
          <ErrorState compact code={list.state.code} message={list.state.code === "not_found" ? "Раздел доступен администратору платформы (адрес должен быть указан в PLATFORM_ADMIN_EMAILS на сервере)." : list.state.message} onRetry={list.reload} />
        )}
        {data && data.models.length === 0 && (
          <EmptyState title="Модели не подключены" description={data.envFallback ? "Используется конфигурация из окружения сервера (PLATFORM_AI_*). Подключите модель здесь, чтобы управлять ею из админ-панели." : "Режим кредитов недоступен, пока не подключена хотя бы одна модель."} />
        )}
        {data && data.models.length > 0 && (
          <ul className="divide-y divide-stroke rounded-card border border-stroke" aria-label="Модели платформы">
            {data.models.map((m) => (
              <li key={m.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0 space-y-1">
                  <p className="flex flex-wrap items-center gap-2 font-medium">
                    <span className="truncate">{PROVIDERS.find((p) => p.id === m.provider)?.name} · {m.model}</span>
                    {m.active && <Badge tone="success" icon={<ShieldCheck aria-hidden />}>Активна</Badge>}
                    <Badge tone={STATUS[m.status].tone}>{STATUS[m.status].label}</Badge>
                  </p>
                  <p className="tabular text-xs text-text-muted">
                    Ключ {m.masked} · вход {formatNumber(m.priceIn)} / выход {formatNumber(m.priceOut)} кредитов за 1000 токенов{m.priceListVersion && ` · прайс ${m.priceListVersion}`}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {!m.active && <Button size="sm" variant="secondary" disabled={busyId === m.id || m.status === "invalid"} onClick={() => void act(m, "activate")}>Сделать активной</Button>}
                  <Button size="sm" variant="ghost" disabled={busyId === m.id} onClick={() => void act(m, "check")}>Проверить ключ</Button>
                  <Button size="sm" variant="ghost" disabled={busyId === m.id} aria-label={`Удалить модель ${m.model}`} onClick={() => void act(m, "delete")}><Trash2 aria-hidden /></Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      <AddModelDialog open={open} onOpenChange={setOpen} onAdded={() => void list.reload()} />
    </Card>
  );
}
