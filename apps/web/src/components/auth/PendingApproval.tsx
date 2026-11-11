"use client";
import { useState } from "react";
import { Icon } from "@/components/Icon";
import { getApi, type AuthUser } from "@/lib/api";
import s from "./auth.module.css";

function Screen({ icon, tone, title, children }: { icon: string; tone?: "red"; title: string; children: React.ReactNode }) {
  return (
    <main className={s.screen}>
      <div className={s.screenCard}>
        <div className={`${s.screenIcon} ${tone === "red" ? s.screenIconRed : ""}`}><Icon name={icon} /></div>
        <h1 className={s.screenTitle}>{title}</h1>
        {children}
      </div>
    </main>
  );
}

async function signOut() {
  try { await getApi().auth.logout(); } catch { /* сессия всё равно закрывается на сервере по таймауту */ }
  window.location.assign("/login");
}

/** Аккаунт подтверждён по почте, но владелец ещё не одобрил доступ. */
export function PendingApproval({ user, onRecheck }: { user: AuthUser; onRecheck: () => void }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  async function recheck() {
    setBusy(true); setNote(null);
    try {
      const me = await getApi().auth.me();
      if (!me) { window.location.assign("/login"); return; }
      if (me.status !== "pending") onRecheck();
      else setNote("Пока без изменений: владелец ещё не одобрил доступ.");
    } catch { setNote("Не удалось проверить статус. Повторите попытку."); }
    setBusy(false);
  }
  return (
    <Screen icon="clock" title="Аккаунт ожидает одобрения владельцем">
      <p className={s.screenText}>
        Почта <strong>{user.email}</strong> подтверждена. Как только владелец одобрит доступ, рабочее пространство откроется — достаточно нажать «Проверить снова».
      </p>
      <div className={s.screenActions}>
        <button type="button" className="btn btn-primary" onClick={recheck} disabled={busy}>{busy ? "Проверяем…" : "Проверить снова"}</button>
        <button type="button" className="btn" onClick={signOut}><Icon name="logout" /> Выйти</button>
      </div>
      <div className={s.screenNote} role="status">{note}</div>
    </Screen>
  );
}

/** Доступ владельцем закрыт. */
export function AccountBlocked({ user }: { user: AuthUser }) {
  return (
    <Screen icon="lock" tone="red" title="Доступ к аккаунту закрыт">
      <p className={s.screenText}>Аккаунт <strong>{user.email}</strong> заблокирован владельцем рабочего пространства. Если это ошибка, свяжитесь с владельцем.</p>
      <div className={s.screenActions}>
        <button type="button" className="btn" onClick={signOut}><Icon name="logout" /> Выйти</button>
      </div>
    </Screen>
  );
}
