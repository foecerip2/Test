"use client";
import { useEffect, useId, useState } from "react";
import { ConfirmDialog } from "../Modal";
import { useToast } from "../Toast";
import { Async, EmptyState, ErrorState, MetricCard, Notice, Panel, StatusTag } from "../ui";
import { ApiError, getApi, type AdminUser } from "@/lib/api";
import { fmtDate, fmtDay, useQuery } from "@/lib/hooks";
import {
  USER_ROLE_LABEL, USER_STATUS_LABEL, USER_STATUS_TONE, adminErrorText, blockDisabledReason, countByStatus, sortUsers, type UserFilter,
} from "@/lib/users";

/** Прямой доступ без прав владельца (вкладка скрыта, но ?tab=users открыть можно). */
export function UsersNoAccess() {
  return <Panel><ErrorState level={2} error={new ApiError(403, "FORBIDDEN", "Недостаточно прав")} /></Panel>;
}

type Pending = { kind: "approve" | "block"; user: AdminUser };

export function UsersTab() {
  const me = useQuery((a) => a.auth.me());
  if (me.loading && !me.data) return <Panel><div className="panel-body"><Async q={me} rows={3}>{() => null}</Async></div></Panel>;
  if (me.data && me.data.role !== "owner") return <UsersNoAccess />;
  return <UsersList meId={me.data?.id ?? null} />;
}

function UsersList({ meId }: { meId: string | null }) {
  const q = useQuery((a) => a.admin.listUsers());
  const toast = useToast();
  const filterId = useId();
  const [filter, setFilter] = useState<UserFilter>("all");
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [patched, setPatched] = useState<Record<string, AdminUser>>({});

  // Свежие данные с сервера заменяют локальные правки.
  useEffect(() => { setPatched({}); }, [q.data]);

  async function confirm() {
    if (!pending || busy) return;
    const { kind, user } = pending;
    setBusy(true); setError(null);
    try {
      const api = getApi().admin;
      const updated = kind === "approve" ? await api.approveUser(user.id) : await api.blockUser(user.id);
      setPatched((p) => ({ ...p, [updated.id]: updated }));
      toast(kind === "approve" ? `Доступ одобрен: ${user.email}` : `Пользователь заблокирован: ${user.email}`);
    } catch (e) {
      setError(adminErrorText(e));
      if (e instanceof ApiError && (e.code === "NOT_FOUND" || e.code === "FORBIDDEN")) q.reload();
    } finally {
      setBusy(false); setPending(null);
    }
  }

  return (
    <Panel title="Пользователи" subtitle="Новые пользователи входят по коду из письма и ждут вашего одобрения">
      <Async q={q} rows={4}>
        {(raw) => {
          const all = raw.map((u) => patched[u.id] ?? u);
          const counts = countByStatus(all);
          const shown = sortUsers(filter === "all" ? all : all.filter((u) => u.status === filter));
          return (
            <>
              <div className="panel-body">
                <div className="metric-grid users-metrics">
                  <MetricCard label="Ожидают одобрения" value={counts.pending} icon="clock" foot={counts.pending ? "Требуют вашего решения" : "Очередь пуста"} />
                  <MetricCard label="Активны" value={counts.active} icon="check" />
                  <MetricCard label="Заблокированы" value={counts.blocked} icon="lock" />
                </div>
                {error && <div role="alert"><Notice tone="danger" icon="alert">{error}</Notice></div>}
                <div className="toolbar users-toolbar" style={{ marginTop: error ? 14 : 0, marginBottom: 0 }}>
                  <label htmlFor={filterId} className="field-label" style={{ margin: 0 }}>Статус</label>
                  <select id={filterId} className="select" value={filter} onChange={(e) => setFilter(e.target.value as UserFilter)}>
                    <option value="all">Все ({all.length})</option>
                    <option value="pending">Ожидают одобрения ({counts.pending})</option>
                    <option value="active">Активны ({counts.active})</option>
                    <option value="blocked">Заблокированы ({counts.blocked})</option>
                  </select>
                  <span className="users-count" role="status">Показано: {shown.length}</span>
                </div>
              </div>
              {all.length === 0 ? (
                <EmptyState icon="user" title="Пользователей пока нет" text="Они появятся здесь после первой регистрации по коду из письма." />
              ) : shown.length === 0 ? (
                <EmptyState icon="user" title="Нет пользователей с таким статусом" text="Выберите другой статус в фильтре." action={<button className="btn" onClick={() => setFilter("all")}>Показать всех</button>} />
              ) : (
                <div className="table-wrap" tabIndex={0} role="region" aria-label="Список пользователей">
                  <table className="data-table cards users-table">
                    <caption className="sr-only">Пользователи: сначала ожидающие одобрения</caption>
                    <thead><tr><th scope="col">Email</th><th scope="col">Роль</th><th scope="col">Статус</th><th scope="col">Регистрация</th><th scope="col">Последний вход</th><th scope="col">Действия</th></tr></thead>
                    <tbody>
                      {shown.map((u) => {
                        const isMe = u.id === meId;
                        const reason = blockDisabledReason(u, meId, all);
                        const canBlock = u.status !== "blocked";
                        const canApprove = u.status !== "active";
                        const reasonId = `block-reason-${u.id}`;
                        return (
                          <tr key={u.id} data-user-status={u.status}>
                            <td className="u-email"><span className="u-mail">{u.email}</span>{isMe && <span className="tag u-me">Это вы</span>}</td>
                            <td data-label="Роль">{USER_ROLE_LABEL[u.role]}</td>
                            <td className="u-status"><StatusTag tone={USER_STATUS_TONE[u.status]}>{USER_STATUS_LABEL[u.status]}</StatusTag></td>
                            <td data-label="Регистрация">{fmtDay(u.createdAt)}</td>
                            <td data-label="Последний вход">{u.lastLoginAt ? fmtDate(u.lastLoginAt) : "ещё не входил"}</td>
                            <td className="u-actions">
                              <div className="u-btns">
                                {canApprove && (
                                  <button className="btn btn-primary" aria-label={`Одобрить: ${u.email}`} onClick={() => { setError(null); setPending({ kind: "approve", user: u }); }}>Одобрить</button>
                                )}
                                {canBlock && (
                                  <button className="btn btn-danger" aria-label={`Заблокировать: ${u.email}`} disabled={reason !== null} aria-describedby={reason ? reasonId : undefined}
                                    onClick={() => { setError(null); setPending({ kind: "block", user: u }); }}>Заблокировать</button>
                                )}
                              </div>
                              {canBlock && reason && <p className="u-reason" id={reasonId}>{reason}</p>}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          );
        }}
      </Async>
      {pending && (
        <ConfirmDialog
          title={pending.kind === "approve" ? "Одобрить доступ?" : "Заблокировать пользователя?"}
          confirmLabel={pending.kind === "approve" ? "Одобрить" : "Заблокировать"}
          danger={pending.kind === "block"}
          busy={busy}
          onConfirm={confirm}
          onCancel={() => { if (!busy) setPending(null); }}
          text={pending.kind === "approve" ? (
            <>
              <p style={{ margin: "0 0 8px" }}><strong className="u-mail">{pending.user.email}</strong></p>
              <p style={{ margin: 0 }}>Пользователь получит доступ к рабочему пространству LeadHunter и сможет входить по коду из письма.</p>
            </>
          ) : (
            <>
              <p style={{ margin: "0 0 8px" }}><strong className="u-mail">{pending.user.email}</strong></p>
              <p style={{ margin: 0 }}>Все активные сессии пользователя будут завершены сразу, а вход станет невозможен. Вернуть доступ можно позже кнопкой «Одобрить».</p>
            </>
          )}
        />
      )}
    </Panel>
  );
}
