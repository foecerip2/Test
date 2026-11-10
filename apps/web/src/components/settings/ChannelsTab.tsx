import { Icon } from "../Icon";
import { Panel, StatusTag } from "../ui";

const CH = [
  { id: "email", name: "Email", icon: "mail", tone: "amber" as const, status: "Выключено до настройки ящика", text: "SMTP/IMAP через рабочий ящик с OAuth или паролем приложения. Исходящие по умолчанию выключены; входящие ответы подтягиваются после настройки.", reason: "Подключение ящика — Фаза 5" },
  { id: "max", name: "MAX", icon: "chat", tone: "neutral" as const, status: "Отключён: нет официального доступа", text: "Бот не может первым писать найденным контактам; доступ зависит от статуса владельца.", reason: "Нет официального доступа для физлица" },
  { id: "vk", name: "VK", icon: "chat", tone: "neutral" as const, status: "Отключён: нет официального доступа", text: "Только сообщения сообщества и разрешённые диалоги; автоматизация личного профиля запрещена.", reason: "Нет официального доступа" },
  { id: "tg", name: "Telegram", icon: "send", tone: "neutral" as const, status: "Отключён: нет официального доступа", text: "Бот не может начать диалог с пользователем, который его не запускал.", reason: "Нет официального доступа" },
];

export function ChannelsTab() {
  return (
    <Panel title="Каналы связи" subtitle="Отправка — только по официальным интерфейсам и при подтверждённом согласии адресата" pad>
      <div className="stack">
        {CH.map((c) => (
          <div key={c.id} className="row between" style={{ border: "1px solid var(--border)", borderRadius: 10, padding: 16, alignItems: "flex-start" }}>
            <div style={{ flex: 1, minWidth: 220 }}>
              <div className="row"><Icon name={c.icon} /><strong>{c.name}</strong><StatusTag tone={c.tone}>{c.status}</StatusTag></div>
              <p className="muted" style={{ marginTop: 8 }}>{c.text}</p>
            </div>
            <button className="btn" disabled title={c.reason} aria-label={`Подключить ${c.name}: недоступно. ${c.reason}`}>Подключить</button>
          </div>
        ))}
      </div>
      <p className="field-hint spacer-top">Для телефона и других неподдерживаемых каналов доступен только ручной контакт: карточка и задача.</p>
    </Panel>
  );
}
