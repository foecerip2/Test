import Link from "next/link";
import { HeroCard } from "@/components/HeroCard";
import { IconBell, IconCalendar, IconCheck, IconInfo, IconLink, IconMinus, IconPhone, IconPlus } from "@/components/Icons";
import { PilotForm } from "@/components/PilotForm";
import { Footer, Header } from "@/components/SiteChrome";

const d = (n: number) => ({ "--d": n }) as React.CSSProperties;

const STEPS = [
  { t: "Клиент открывает вашу страницу записи", p: "По ссылке или QR-коду: выбирает услугу и удобное время, оставляет имя и телефон. Регистрироваться не нужно." },
  { t: "Заявка приходит вам", p: "В кабинет и уведомлением на телефон. Вы подтверждаете запись или предлагаете другое время." },
  { t: "Расписание не пересекается", p: "Занятое время закрыто для записи, двойных записей на один бокс не будет. Клиент получает подтверждение." },
];

const FAQ = [
  { q: "Сколько это стоит?", a: <>Цен пока нет: условия пилота обсуждаются индивидуально. Дальше — подписка с оплатой помесячно. Оставьте заявку, и мы расскажем подробнее.</> },
  { q: "Клиентам нужно регистрироваться?", a: <>Нет. Клиент указывает имя, телефон, услугу и время, а также соглашается на обработку персональных данных.</> },
  { q: "Как вы обращаетесь с персональными данными?", a: <>Работаем по 152-ФЗ. Черновик политики обработки данных опубликован на странице <Link href="/privacy">Политика</Link>. Данные планируем хранить на серверах в России.</> },
  { q: "Есть ли приложение?", a: <>Кабинет автосервиса откроется в браузере, а также будет Android-приложение с теми же заявками и расписанием. Версии для iOS пока нет.</> },
  { q: "Это замена учётной программе?", a: <>Нет. Склад, оплата услуг клиентом, CRM-воронки и интеграции с 1С в первую версию не входят: AutoFlow отвечает за заявки и запись.</> },
  { q: "Когда запуск?", a: <>Первая версия разрабатывается, пилот пройдёт на ранней версии вместе с первыми автосервисами. Дат не обещаем, пока не уверены в них.</> },
];

export default function Home() {
  return (
    <>
      <a className="skip" href="#main">
        Перейти к содержимому
      </a>
      <Header home />
      <main id="main">
        <section className="hero" aria-labelledby="h1">
          <div className="wrap hero-grid">
            <div>
              <span className="eyebrow rise" style={d(0)}>
                Для автосервисов · набираем пилот
              </span>
              <h1 id="h1" className="rise" style={d(1)}>
                Заявки и запись клиентов — <em>без звонков</em>
              </h1>
              <p className="lead rise" style={d(2)}>
                AutoFlow даёт автосервису страницу онлайн-записи, расписание и список заявок в одном месте. Клиент сам выбирает услугу и время, а вы сразу видите заявку.
              </p>
              <div className="cta-row rise" style={d(3)}>
                <a className="btn btn--primary" href="#pilot">
                  Хочу пилот
                </a>
                <a className="btn btn--ghost" href="#how">
                  Как это работает
                </a>
              </div>
              <p className="hero-note rise" style={d(4)}>
                <IconInfo size={20} />
                Условия пилота обсуждаются лично. Дальше — подписка помесячно.
              </p>
            </div>
            <HeroCard />
          </div>
        </section>

        <section className="section band" id="how" aria-labelledby="how-h">
          <div className="wrap">
            <span className="eyebrow">Как это работает</span>
            <h2 className="h2" id="how-h">
              Три шага от клика до записи в расписании
            </h2>
            <ol className="steps">
              {STEPS.map((s, i) => (
                <li className="step" key={s.t}>
                  <span className="step-n" aria-hidden="true">
                    0{i + 1}
                  </span>
                  <h3>{s.t}</h3>
                  <p>{s.p}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="section" id="features" aria-labelledby="feat-h">
          <div className="wrap">
            <span className="eyebrow">Первая версия</span>
            <h2 className="h2" id="feat-h">
              Что войдёт в AutoFlow сначала
            </h2>
            <p className="lead" style={{ marginTop: 16 }}>
              Минимум, чтобы принимать записи и не терять заявки. Остальное добавим вместе с первыми автосервисами.
            </p>
            <div className="bento">
              <article className="feat">
                <div className="feat-ico">
                  <IconLink />
                </div>
                <h3>Публичная страница записи</h3>
                <p>У каждого автосервиса своя ссылка и QR-код. Клиент выбирает услугу и свободное время, оставляет имя и телефон и даёт согласие на обработку данных.</p>
                <ul aria-label="Что указывает клиент">
                  <li>Услуга</li>
                  <li>Время</li>
                  <li>Имя и телефон</li>
                </ul>
              </article>
              <article className="feat">
                <div className="feat-ico">
                  <IconBell />
                </div>
                <h3>Уведомления</h3>
                <p>Вам — о новой заявке на e-mail и push в приложении. Клиенту — подтверждение и напоминание на e-mail.</p>
              </article>
              <article className="feat">
                <div className="feat-ico">
                  <IconPhone />
                </div>
                <h3>Кабинет и Android-приложение</h3>
                <p>Заявки и расписание в браузере и на телефоне. Вход по коду из письма, пароль не нужен.</p>
              </article>
              <article className="feat">
                <div className="feat-ico">
                  <IconCalendar />
                </div>
                <h3>Расписание и заявки</h3>
                <p>Статусы заявок, боксы или мастера, рабочие часы и исключения. Защита от двойной записи на одно время.</p>
                <ul aria-label="Статусы заявок">
                  <li>Новая</li>
                  <li>Подтверждена</li>
                  <li>Выполнена</li>
                  <li>Отменена</li>
                </ul>
              </article>
            </div>
          </div>
        </section>

        <section className="section dark-band dark" id="who" aria-labelledby="who-h">
          <div className="wrap">
            <span className="eyebrow">Для кого</span>
            <h2 className="h2" id="who-h">
              Для автосервисов, которые записывают клиентов на время
            </h2>
            <div className="who">
              <div>
                <h3>Подойдёт</h3>
                <ul className="tags">
                  <li>Станции техобслуживания</li>
                  <li>Шиномонтаж</li>
                  <li>Кузовной ремонт</li>
                  <li>Автоэлектрика</li>
                  <li>Детейлинг и мойка</li>
                </ul>
                <p className="lead not-in">Особенно если заявки сейчас приходят звонками и в мессенджерах и теряются между ними.</p>
              </div>
              <div>
                <h3>Что получите</h3>
                <ul className="checks">
                  <li>
                    <IconCheck size={22} />
                    Все заявки в одном списке со статусами
                  </li>
                  <li>
                    <IconCheck size={22} />
                    Запись по ссылке или QR-коду, без звонков
                  </li>
                  <li>
                    <IconCheck size={22} />
                    Занятое время закрыто от повторной записи
                  </li>
                </ul>
                <h3 style={{ marginTop: 32 }}>Пока не входит</h3>
                <ul className="checks checks--no">
                  <li>
                    <IconMinus size={22} />
                    Онлайн-оплата услуг, складской учёт, CRM-воронки
                  </li>
                  <li>
                    <IconMinus size={22} />
                    Интеграции с 1С и внешними каталогами
                  </li>
                </ul>
              </div>
            </div>
          </div>
        </section>

        <section className="section pilot" id="pilot" aria-labelledby="pilot-h">
          <div className="wrap pilot-grid">
            <div>
              <span className="eyebrow">Пилот</span>
              <h2 className="h2" id="pilot-h">
                Хочу пилот
              </h2>
              <p className="lead" style={{ marginTop: 16 }}>
                Расскажите об автосервисе и оставьте контакт: мы свяжемся и обсудим, как подключить запись именно у вас.
              </p>
              <div className="price-box">
                <b>Условия пилота обсуждаются</b>
                <p>Цены заранее не называем: сначала разбираемся, что нужно вашему автосервису.</p>
              </div>
            </div>
            <PilotForm />
          </div>
        </section>

        <section className="section band" id="faq" aria-labelledby="faq-h">
          <div className="wrap">
            <span className="eyebrow">Вопросы и ответы</span>
            <h2 className="h2" id="faq-h">
              Частые вопросы
            </h2>
            <div className="faq">
              {FAQ.map((f) => (
                <details key={f.q}>
                  <summary>
                    {f.q}
                    <IconPlus size={22} />
                  </summary>
                  <div className="ans">{f.a}</div>
                </details>
              ))}
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
