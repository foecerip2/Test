import { HeroCard } from "@/components/HeroCard";
import {
  IconCalendar,
  IconCheck,
  IconLink,
  IconPlus,
  IconPhone,
} from "@/components/Icons";
import { PilotForm } from "@/components/PilotForm";
import { Reveal } from "@/components/Reveal";
import { Footer, Header } from "@/components/SiteChrome";

const STEPS = [
  {
    title: "Одна ссылка для клиентов",
    text: "Клиент открывает страницу автосервиса, выбирает услугу и время. Без длинной переписки и поиска номера телефона.",
  },
  {
    title: "Каждая заявка на виду",
    text: "Все записи собраны в расписании. Видно, кто приедет, на какую услугу и какой бокс будет занят.",
  },
  {
    title: "Вы управляете своим днём",
    text: "Подтверждайте записи, меняйте статусы и оставляйте заметки. У команды всегда одна актуальная картина.",
  },
];
const FAQ = [
  {
    q: "Сколько это стоит?",
    a: "Условия пилота обсуждаются индивидуально. Дальше — подписка с оплатой помесячно. Оставьте заявку, и мы обсудим ваш автосервис.",
  },
  {
    q: "Как принять участие в пилоте?",
    a: "Оставьте заявку на этой странице. Мы свяжемся с вами, чтобы обсудить задачи автосервиса и условия участия.",
  },
  {
    q: "Клиентам нужно регистрироваться?",
    a: "В публичной записи регистрация для клиентов не планируется: достаточно выбрать услугу, время и оставить контакт. Пока эту часть продукта готовим к пилоту.",
  },
  {
    q: "Есть приложение для телефона?",
    a: "Рабочее приложение для телефона и компьютера проходит закрытое тестирование. О доступе к пилоту расскажем после заявки.",
  },
  {
    q: "Это замена учётной программе?",
    a: "AutoFlow сосредоточен на записи клиентов и расписании. Складской учёт и интеграции с 1С в первую версию не входят.",
  },
];
export default function Home() {
  return (
    <>
      <a className="skip" href="#main">
        Перейти к содержимому
      </a>
      <Header home />
      <Reveal />
      <main id="main">
        <section className="hero" aria-labelledby="h1">
          <div className="wrap hero-grid">
            <div className="hero-copy rise">
              <span className="hero-badge">
                <i /> Программа записи для автосервиса
              </span>
              <h1 id="h1">
                Запись клиентов
                <br />
                <em>без путаницы.</em>
              </h1>
              <p className="lead">
                Расписание, услуги и записи в одном рабочем окне. Видно, кто
                приедет, когда и какой бокс будет занят.
              </p>
              <div className="cta-row">
                <a className="btn btn--primary" href="#pilot">
                  Хочу пилот <span aria-hidden="true">↗</span>
                </a>
                <a className="hero-secondary" href="#how">
                  Как это работает <span aria-hidden="true">↓</span>
                </a>
              </div>
              <p className="hero-note">
                <span className="tiny-check">
                  <IconCheck size={13} />
                </span>{" "}
                Условия пилота обсуждаются лично
              </p>
            </div>
            <HeroCard />
          </div>
        </section>
        <section className="section band" id="how" aria-labelledby="how-h">
          <div className="wrap" data-reveal>
            <div className="section-head">
              <span className="eyebrow">ПРОСТОЙ РАБОЧИЙ ПРОЦЕСС</span>
              <h2 className="h2" id="how-h">
                Три шага от клика до записи в расписании
              </h2>
            </div>
            <ol className="steps">
              {STEPS.map((s, i) => (
                <li className="step" key={s.title}>
                  <span className="step-n">0{i + 1}</span>
                  <h3>{s.title}</h3>
                  <p>{s.text}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>
        <section className="section" id="features" aria-labelledby="feat-h">
          <div className="wrap" data-reveal>
            <div className="section-head">
              <span className="eyebrow">ПРОДУКТ БЕЗ ЛИШНЕГО</span>
              <h2 className="h2" id="feat-h">
                Что войдёт в AutoFlow сначала
              </h2>
              <p>Начинаем с самого важного для вашего рабочего дня.</p>
            </div>
            <div className="feature-grid">
              <article className="feature-main">
                <div className="feature-top">
                  <IconCalendar size={24} />
                  <span>01 / РАСПИСАНИЕ</span>
                </div>
                <h3>
                  У каждого бокса —<br />
                  своё место в дне.
                </h3>
                <p>
                  Продолжительность услуги и рабочие часы определяют время
                  записи. Пересечения проверяются на сервере.
                </p>
                <div className="feature-timeline" aria-hidden="true">
                  <span>09:00</span>
                  <i />
                  <b>Диагностика</b>
                  <i />
                  <span>12:00</span>
                </div>
              </article>
              <article className="feature-side">
                <IconLink size={25} />
                <h3>Клиентам — простая запись.</h3>
                <p>
                  Персональная ссылка для автосервиса. Публичную запись откроем
                  после закрытого тестирования.
                </p>
                <div className="mini-link">
                  autoflow / ваш автосервис <span>↗</span>
                </div>
              </article>
              <article className="feature-side">
                <IconPhone size={25} />
                <h3>Кабинет всегда под рукой.</h3>
                <p>
                  Один продукт на компьютере и телефоне. Сейчас — закрытый
                  доступ для администрации.
                </p>
                <a href="#pilot" className="text-link">
                  Обсудить пилот <span>→</span>
                </a>
              </article>
            </div>
          </div>
        </section>
        <section className="product-band">
          <div className="wrap" data-reveal>
            <span className="eyebrow">СОЗДАЁМ ВМЕСТЕ С АВТОСЕРВИСАМИ</span>
            <h2>
              Хороший сервис
              <br />
              начинается с порядка.
            </h2>
            <p>
              СТО, шиномонтаж, детейлинг, автоэлектрика — если вы записываете
              клиентов на время, давайте обсудим пилот.
            </p>
            <a href="#pilot" className="btn btn--light">
              Обсудить пилот <span>↗</span>
            </a>
          </div>
        </section>
        <section className="section pilot" id="pilot" aria-labelledby="pilot-h">
          <div className="wrap pilot-grid">
            <div data-reveal>
              <span className="eyebrow">ПЕРВЫЕ АВТОСЕРВИСЫ</span>
              <h2 className="h2" id="pilot-h">
                Проверим AutoFlow
                <br />в вашем рабочем дне.
              </h2>
              <p className="lead">
                Расскажите немного об автосервисе. Свяжемся, обсудим задачи и
                условия участия.
              </p>
              <div className="pilot-details">
                <IconCheck size={18} />
                <p>
                  <b>Условия пилота обсуждаются</b>
                  <span>
                    Дальше — подписка помесячно. Цены и сроки заранее не
                    придумываем.
                  </span>
                </p>
              </div>
            </div>
            <PilotForm />
          </div>
        </section>
        <section className="section band" id="faq" aria-labelledby="faq-h">
          <div className="wrap faq-grid" data-reveal>
            <div>
              <span className="eyebrow">ЕЩЁ ПАРА ДЕТАЛЕЙ</span>
              <h2 className="h2" id="faq-h">
                Частые вопросы
              </h2>
            </div>
            <div className="faq">
              {FAQ.map((f) => (
                <details key={f.q}>
                  <summary>
                    {f.q}
                    <IconPlus size={19} />
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
