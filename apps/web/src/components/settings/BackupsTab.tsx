import { EmptyState, Panel } from "../ui";

export function BackupsTab() {
  return (
    <Panel title="Резервные копии">
      <EmptyState icon="download" title="Нет данных" text="Шифрованные ежедневные копии, проверка восстановления и откат настраиваются в Фазе 6. До этого здесь нечего показывать — цифры не подставляются." />
    </Panel>
  );
}
