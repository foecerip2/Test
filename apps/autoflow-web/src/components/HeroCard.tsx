import { IconBell } from "@/components/Icons";

/** Иллюстрация первой версии: расписание дня и новая заявка. Данные вымышленные, подписано «Пример интерфейса». */
export function HeroCard() {
  return (
    <div className="board rise" style={{ "--d": 3 } as React.CSSProperties} role="img" aria-label="Пример интерфейса: расписание на день, новая заявка получает статус «Подтверждена»">
      <div className="board-inner" aria-hidden="true">
        <div className="board-head">
          <span className="board-title">Расписание на день</span>
          <span className="board-tag">Пример интерфейса</span>
        </div>
        <ul className="slots">
          <li className="slot">
            <time>10:00</time>
            <span>Замена масла</span>
            <span className="chip chip--ok">Подтверждена</span>
          </li>
          <li className="slot slot--new">
            <time>12:30</time>
            <span>Диагностика ходовой</span>
            <span className="chip-stack">
              <span className="chip chip--new">Новая</span>
              <span className="chip chip--ok chip--later">Подтверждена</span>
            </span>
          </li>
          <li className="slot slot--free">
            <time>14:00</time>
            <span>Свободно</span>
            <span />
          </li>
          <li className="slot slot--free">
            <time>16:30</time>
            <span>Свободно</span>
            <span />
          </li>
        </ul>
        <div className="notice">
          <IconBell size={22} />
          <p>
            <b>Новая заявка</b>
            <span>Шиномонтаж · завтра 09:00</span>
          </p>
        </div>
      </div>
    </div>
  );
}
