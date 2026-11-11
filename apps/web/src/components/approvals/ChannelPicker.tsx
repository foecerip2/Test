"use client";
import type { Channel } from "@/lib/api";

export const CHANNELS: { id: Channel; label: string; manual: boolean }[] = [
  { id: "email", label: "Email", manual: false },
  { id: "max", label: "MAX", manual: true },
  { id: "vk", label: "VK", manual: true },
  { id: "telegram", label: "Telegram", manual: true },
  { id: "phone", label: "Телефон", manual: true },
];

export function ChannelPicker({ value, onChange, disabled }: { value: Channel; onChange: (c: Channel) => void; disabled?: boolean }) {
  return (
    <div role="group" aria-labelledby="channel-label">
      <span className="field-label" id="channel-label">Канал коммуникации</span>
      <div className="choice-row">
        {CHANNELS.map((c) => (
          <button key={c.id} type="button" className="choice" aria-pressed={value === c.id} disabled={disabled} onClick={() => onChange(c.id)}>
            {c.label}{c.manual && <span className="small muted" style={{ display: "block", fontWeight: 500 }}>ручной контакт</span>}
          </button>
        ))}
      </div>
      <p className="field-hint">Автоматическая отправка доступна только по email и только при подтверждённом согласии. Остальные каналы — подготовка текста для ручного действия.</p>
    </div>
  );
}
