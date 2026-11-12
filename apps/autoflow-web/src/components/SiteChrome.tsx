import Link from "next/link";
import { LogoMark } from "@/components/Icons";
import { siteConfig } from "@/lib/config";

export function Header({ home = false }: { home?: boolean }) {
  const p = home ? "" : "/";
  return (
    <header className="top">
      <div className="wrap top-in">
        <Link className="logo" href="/" aria-label="AutoFlow — на главную">
          <LogoMark />
          AutoFlow
        </Link>
        <nav className="nav" aria-label="Разделы страницы">
          <a href={`${p}#how`}>Как это работает</a>
          <a href={`${p}#features`}>Возможности</a>
          <a href={`${p}#faq`}>Вопросы</a>
        </nav>
        <div className="header-actions">
          <Link className="header-login" href="/login">
            Войти
          </Link>
          <a className="btn btn--primary btn--sm" href={`${p}#pilot`}>
            Хочу пилот
          </a>
        </div>
      </div>
    </header>
  );
}

export function Footer() {
  return (
    <footer className="foot">
      <div className="wrap">
        <div className="foot-grid">
          <div>
            <Link className="logo" href="/" aria-label="AutoFlow — на главную">
              <LogoMark />
              AutoFlow
            </Link>
            <p className="lead" style={{ marginTop: 14, fontSize: "1rem" }}>
              Заявки и запись клиентов для автосервисов. Сервис готовится к
              запуску: сейчас набираем пилот.
            </p>
          </div>
          <div>
            <h2>Контакты</h2>
            <ul>
              <li>
                {siteConfig.contactEmail.endsWith(".example") ? (
                  <Link href="/#pilot">Форма заявки</Link>
                ) : (
                  <a href={`mailto:${siteConfig.contactEmail}`}>
                    {siteConfig.contactEmail}
                  </a>
                )}
              </li>
              {siteConfig.contactTelegram ? (
                <li>
                  <a
                    href={`https://t.me/${siteConfig.contactTelegram.replace(/^@/, "")}`}
                    rel="noopener noreferrer"
                  >
                    Telegram {siteConfig.contactTelegram}
                  </a>
                </li>
              ) : null}
            </ul>
          </div>
          <div>
            <h2>Документы</h2>
            <ul>
              <li>
                <Link href="/login">Личный кабинет</Link>
              </li>
              <li>
                <Link href="/privacy">
                  Политика обработки персональных данных
                </Link>
              </li>
              <li>
                <Link href="/#pilot">Оставить заявку на пилот</Link>
              </li>
            </ul>
          </div>
        </div>
        <p className="foot-small">
          AutoFlow. Информация на странице ознакомительная и не является
          публичной офертой.
        </p>
      </div>
    </footer>
  );
}
