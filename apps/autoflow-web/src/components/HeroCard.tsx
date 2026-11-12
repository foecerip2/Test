import Image from "next/image";

/** Снимок настоящего интерфейса с вымышленными данными из тестового окружения. */
export function HeroCard() {
  return (
    <figure className="product-preview rise">
      <div className="preview-image-wrap">
        <Image
          src="/app-preview.png"
          alt="Расписание AutoFlow: записи распределены по времени и рабочим боксам"
          width={1440}
          height={900}
          priority
          sizes="(max-width: 850px) 100vw, 52vw"
        />
      </div>
      <figcaption className="preview-live">
        Экран работающего кабинета · данные для примера
      </figcaption>
    </figure>
  );
}
