"use client";
import { useState } from "react";
import { IconCalendar, IconCheck } from "./Icons";

/** Только иллюстрация продукта: на лендинге всегда подписана как пример. */
export function HeroCard() {
  const [confirmed, setConfirmed] = useState(false);
  return (
    <div
      className="product-preview rise"
      aria-label="Пример интерфейса AutoFlow"
    >
      <div className="preview-chrome">
        <span className="preview-mark">a.</span>
        <span>
          Север Авто <small>Пример интерфейса</small>
        </span>
        <span className="preview-avatar">СА</span>
      </div>
      <div className="preview-body">
        <div className="preview-heading">
          <div>
            <span>ВСЁ ПОД КОНТРОЛЕМ</span>
            <h2>
              Хороший день начинается
              <br />с расписания.
            </h2>
          </div>
          <IconCalendar size={22} />
        </div>
        <div className="preview-week" aria-hidden="true">
          {["Пн", "Вт", "Ср", "Чт", "Пт"].map((label, i) => (
            <span key={label} className={i === 2 ? "selected" : ""}>
              {label}
              <b>{12 + i}</b>
            </span>
          ))}
        </div>
        <div className="preview-columns">
          <span>Время</span>
          <span>Бокс 01</span>
          <span>Бокс 02</span>
        </div>
        <div className="preview-schedule">
          <div className="preview-times">
            <span>09:00</span>
            <span>10:00</span>
            <span>11:00</span>
            <span>12:00</span>
          </div>
          <div className="preview-track">
            <div className="preview-event blue">
              <span>09:00 – 10:00</span>
              <strong>Замена масла</strong>
              <small>Иван · Подтверждена</small>
            </div>
            <div className={`preview-event ${confirmed ? "green" : "amber"}`}>
              <span>11:00 – 12:00</span>
              <strong>Диагностика</strong>
              <small>
                {confirmed ? "Запись подтверждена" : "Ожидает подтверждения"}
              </small>
            </div>
          </div>
          <div className="preview-track">
            <div className="preview-free">Свободное время</div>
            <div className="preview-event green">
              <span>10:00 – 11:30</span>
              <strong>Шиномонтаж</strong>
              <small>Анна · Подтверждена</small>
            </div>
          </div>
        </div>
        <div className="preview-action">
          <span className="preview-notify">
            <span className="notify-dot" />
            <span>
              <strong>{confirmed ? "Всё готово" : "Новая запись"}</strong>
              <small>
                {confirmed ? "Пример: статус изменён" : "Диагностика · Бокс 01"}
              </small>
            </span>
          </span>
          <button
            type="button"
            onClick={() => setConfirmed((v) => !v)}
            className={confirmed ? "is-confirmed" : ""}
          >
            {confirmed ? (
              <>
                <IconCheck size={15} /> Подтверждена
              </>
            ) : (
              "Подтвердить"
            )}
          </button>
        </div>
      </div>
      <p className="preview-live" role="status">
        {confirmed
          ? "Пример: запись подтверждена"
          : "Попробуйте подтвердить запись в примере"}
      </p>
    </div>
  );
}
