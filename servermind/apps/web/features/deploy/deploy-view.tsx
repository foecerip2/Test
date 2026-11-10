"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { CheckCircle2, CircleAlert, Plus, Rocket, TriangleAlert, Trash2, XCircle } from "lucide-react";
import { api, type PreflightCheck } from "@/lib/api";
import { useResource } from "@/lib/use-resource";
import { useToast } from "@/lib/toast";
import { checkDomain } from "@/lib/validation";
import { formatDateTimeUtc } from "@/lib/format";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/input";
import { SecretInput } from "@/components/ui/secret-input";
import { EmptyState, ErrorState, InlineAlert } from "@/components/ui/states";
import { SkeletonBlock } from "@/components/ui/skeleton";
import { ServerPicker } from "@/features/servers/server-picker";
import { Stepper } from "@/features/servers/add-server-wizard";
import { JobStatusBadge, SourceBadge } from "@/features/status";
import { cn } from "@/lib/utils";

const STEPS = ["Шаблон", "Сервер и домен", "Переменные", "Проверка и план"] as const;
const ENV_KEY = /^[A-Z_][A-Z0-9_]{0,63}$/;

interface EnvRow { key: string; value: string }

export function DeployView() {
  const router = useRouter();
  const toast = useToast();
  const templates = useResource(() => api.deploy.templates(), []);
  const servers = useResource(() => api.servers.list(), []);
  const deployments = useResource(() => api.deploy.list(), [], { pollMs: 10_000 });
  const ops = useResource(() => api.operations.list(), []);

  const [step, setStep] = useState(0);
  const [templateId, setTemplateId] = useState("web-app");
  const [serverId, setServerId] = useState("");
  const [domain, setDomain] = useState("");
  const [domainErr, setDomainErr] = useState<string | null>(null);
  const [env, setEnv] = useState<EnvRow[]>([]);
  const [envErr, setEnvErr] = useState<string | null>(null);
  const [checks, setChecks] = useState<PreflightCheck[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const serverList = servers.state.status === "ready" ? servers.state.data : [];
  const chosen = serverId || serverList.find((s) => s.status === "online")?.id || serverList[0]?.id || "";
  const blocked = checks?.some((c) => c.blocking && c.status === "fail") ?? false;
  const input = () => ({ serverId: chosen, templateId, domain: domain.trim(), envKeys: env.map((e) => e.key) });

  const nextFromServer = () => {
    if (!chosen) return;
    if (domain.trim() && !checkDomain(domain)) { setDomainErr("Некорректное доменное имя."); return; }
    setDomainErr(null); setStep(2);
  };
  const nextFromEnv = () => {
    const keys = env.map((e) => e.key);
    if (keys.some((k) => !ENV_KEY.test(k))) { setEnvErr("Имя переменной: заглавные латинские буквы, цифры и _ (например, DATABASE_URL)."); return; }
    if (new Set(keys).size !== keys.length) { setEnvErr("Имена переменных не должны повторяться."); return; }
    if (env.some((e) => !e.value)) { setEnvErr("Заполните значения или удалите пустые строки."); return; }
    setEnvErr(null); setStep(3);
  };

  const runPreflight = async () => {
    setChecking(true); setCheckError(null); setChecks(null);
    const r = await api.deploy.preflight(input());
    setChecking(false);
    if (r.ok) setChecks(r.data); else setCheckError(r.message);
  };

  const createPlan = async () => {
    setCreating(true);
    const r = await api.deploy.createPlan(input());
    setCreating(false);
    if (r.ok) { toast.push({ tone: "success", title: "План создан", description: "Проверьте его и подтвердите — пока ничего не выполняется." }); router.push(`/operations/op_${r.data.id}/approve`); }
    else toast.push({ tone: "error", title: "Не удалось создать план", description: r.message });
  };

  return (
    <>
      <PageHeader title="Деплой" description="Развёртывание проверенных шаблонов. Произвольные compose-файлы и Dockerfile в первом релизе не поддерживаются." />

      {(servers.state.status === "error" || templates.state.status === "error") && (
        <ErrorState className="mb-6" code={servers.state.status === "error" ? servers.state.code : "error"} message={servers.state.status === "error" ? servers.state.message : "Не удалось загрузить шаблоны."} onRetry={() => { void servers.reload(); void templates.reload(); }} />
      )}

      {servers.state.status === "ready" && serverList.length === 0 && (
        <EmptyState icon={<Rocket aria-hidden />} title="Нет серверов для деплоя" description="Сначала подключите сервер." action={<Link href="/servers/new" className={buttonVariants()}>Добавить сервер</Link>} />
      )}

      {serverList.length > 0 && templates.state.status === "ready" && (
        <div className="mx-auto max-w-3xl">
          <Stepper steps={STEPS} current={step} />

          {step === 0 && (
            <Card>
              <CardHeader><CardTitle>1. Выберите шаблон</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                <div role="radiogroup" aria-label="Шаблон приложения" className="grid gap-3">
                  {templates.state.data.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      role="radio"
                      aria-checked={templateId === t.id}
                      disabled={!t.available}
                      onClick={() => setTemplateId(t.id)}
                      className={cn(
                        "rounded-card border p-4 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                        templateId === t.id && t.available ? "border-primary bg-primary-muted/40" : "border-stroke hover:bg-elevated",
                      )}
                    >
                      <span className="flex flex-wrap items-center gap-2 font-medium">{t.name}{!t.available && <Badge>Скоро</Badge>}{t.available && <Badge tone="primary">порт {t.port}</Badge>}</span>
                      <span className="mt-1 block text-sm text-text-secondary">{t.description}</span>
                    </button>
                  ))}
                </div>
                <div className="flex justify-end"><Button onClick={() => setStep(1)}>Далее</Button></div>
              </CardContent>
            </Card>
          )}

          {step === 1 && (
            <Card>
              <CardHeader><CardTitle>2. Сервер и домен</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                <Field label="Сервер">{(p) => <ServerPicker id={p.id} servers={serverList} value={chosen} onChange={setServerId} />}</Field>
                <Field label="Домен (необязательно)" error={domainErr} hint="Для HTTPS нужна A-запись, указывающая на сервер. Без домена приложение доступно только локально на сервере.">
                  {(p) => <Input {...p} value={domain} onChange={(e) => { setDomain(e.target.value); setDomainErr(null); }} placeholder="app.servermind.example" autoCapitalize="off" spellCheck={false} />}
                </Field>
                <div className="flex justify-between gap-2"><Button variant="ghost" onClick={() => setStep(0)}>Назад</Button><Button onClick={nextFromServer}>Далее</Button></div>
              </CardContent>
            </Card>
          )}

          {step === 2 && (
            <Card>
              <CardHeader><CardTitle>3. Переменные окружения</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                <InlineAlert tone="info" title="Секреты">Значения вводятся в защищённые поля и не сохраняются в браузере. В план и журнал попадают только имена переменных.</InlineAlert>
                {env.length === 0 && <p className="text-sm text-text-muted">Переменных нет — это допустимо.</p>}
                <ul className="space-y-3">
                  {env.map((row, i) => (
                    <li key={i} className="grid grid-cols-[1fr_auto] gap-2 sm:grid-cols-[200px_1fr_auto]">
                      <Input aria-label={`Имя переменной ${i + 1}`} placeholder="DATABASE_URL" value={row.key} onChange={(e) => setEnv((l) => l.map((r, j) => (j === i ? { ...r, key: e.target.value.toUpperCase() } : r)))} className="font-mono" />
                      <Button variant="ghost" size="icon" aria-label={`Удалить переменную ${i + 1}`} className="sm:order-3" onClick={() => setEnv((l) => l.filter((_, j) => j !== i))}><Trash2 aria-hidden /></Button>
                      <div className="col-span-2 sm:col-span-1"><SecretInput aria-label={`Значение переменной ${i + 1}`} value={row.value} onChange={(e) => setEnv((l) => l.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))} /></div>
                    </li>
                  ))}
                </ul>
                {envErr && <p role="alert" className="text-sm text-danger">{envErr}</p>}
                <Button variant="secondary" size="sm" disabled={env.length >= 20} onClick={() => setEnv((l) => [...l, { key: "", value: "" }])}><Plus aria-hidden /> Добавить переменную</Button>
                <div className="flex justify-between gap-2"><Button variant="ghost" onClick={() => setStep(1)}>Назад</Button><Button onClick={nextFromEnv}>Далее</Button></div>
              </CardContent>
            </Card>
          )}

          {step === 3 && (
            <Card>
              <CardHeader><CardTitle>4. Проверка и план</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm text-text-secondary">Preflight только читает состояние сервера. Затем создаётся план, который нужно подтвердить на отдельном экране.</p>
                {!checks && <Button variant="secondary" onClick={runPreflight} loading={checking}>Запустить проверки</Button>}
                {checkError && <InlineAlert tone="danger" title="Проверки не выполнены">{checkError}</InlineAlert>}
                {checks && (
                  <ul className="divide-y divide-stroke rounded-card border border-stroke" aria-label="Результаты проверок">
                    {checks.map((c) => {
                      const Icon = c.status === "pass" ? CheckCircle2 : c.status === "warn" ? TriangleAlert : XCircle;
                      return (
                        <li key={c.id} className="flex gap-3 p-3">
                          <Icon aria-hidden className={cn("mt-0.5 size-5 shrink-0", c.status === "pass" && "text-success", c.status === "warn" && "text-warning", c.status === "fail" && "text-danger")} />
                          <div className="min-w-0 text-sm">
                            <p className="font-medium">{c.label} <span className="sr-only">— {c.status === "pass" ? "успешно" : c.status === "warn" ? "предупреждение" : "ошибка"}</span>{c.blocking && c.status === "fail" && <Badge tone="danger" className="ml-2">блокирует</Badge>}</p>
                            <p className="text-text-secondary">{c.detail}</p>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
                {blocked && <InlineAlert tone="danger" title="Деплой заблокирован">Устраните причину и повторите проверки. Ресурсоёмкие операции не выполняются при диске ≥ 90% и недоступном сервере.</InlineAlert>}
                <div className="flex flex-wrap justify-between gap-2">
                  <Button variant="ghost" onClick={() => { setStep(2); setChecks(null); }}>Назад</Button>
                  <div className="flex gap-2">
                    {checks && <Button variant="secondary" onClick={runPreflight} loading={checking}>Повторить</Button>}
                    <Button disabled={!checks || blocked} loading={creating} onClick={createPlan}><Rocket aria-hidden /> Создать план</Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      <section className="mt-10" aria-labelledby="dep-h">
        <h2 id="dep-h" className="mb-3">Развёртывания</h2>
        {deployments.state.status === "loading" && <SkeletonBlock className="h-24 rounded-card" />}
        {deployments.state.status === "error" && <ErrorState compact code={deployments.state.code} message={deployments.state.message} onRetry={deployments.reload} />}
        {deployments.state.status === "ready" && deployments.state.data.length === 0 && <p className="text-sm text-text-muted">Развёртываний ещё не было.</p>}
        {deployments.state.status === "ready" && deployments.state.data.length > 0 && (
          <ul className="space-y-3">
            {deployments.state.data.map((d) => {
              const op = ops.state.status === "ready" ? ops.state.data.find((o) => o.id === d.operationId) : undefined;
              return (
                <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-stroke bg-surface p-4">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 font-medium">{d.template}<SourceBadge source={d.source} /></p>
                    <p className="text-sm text-text-secondary">{d.serverName}{d.domain ? ` · ${d.domain}` : ""} · {formatDateTimeUtc(d.createdAt)}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    {op ? <JobStatusBadge status={op.status} /> : <Badge icon={<CircleAlert aria-hidden />}>{d.status}</Badge>}
                    {d.operationId && <Link className="text-sm text-primary hover:underline" href={op?.status === "waiting_approval" ? `/operations/${d.operationId}/approve` : `/operations/${d.operationId}`}>Открыть</Link>}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </>
  );
}
