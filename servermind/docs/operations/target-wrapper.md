# Обёртка `servermind-op` на целевом сервере (реальное исполнение)

Реальное исполнение изменений на подключённом сервере **выключено по умолчанию** и возможно только после того, как **владелец этого сервера** сам поставит обёртку. ServerMind ничего не устанавливает на целевой сервер и не получает общего sudo: пользователь ServerMind может запускать через sudo ТОЛЬКО этот скрипт, а скрипт умеет ТОЛЬКО две операции (`service.restart`, `http.healthcheck`).

## Что делает обёртка
- Принимает `servermind-op <операция> '<параметры-JSON>'`, проверяет параметры заново (те же правила, что в каталоге ServerMind), запрещает лишние поля.
- Никакой оболочки: команды запускаются массивом аргументов (`shell=False`), JSON в строки команд не подставляется.
- `service.restart` — только для служб из **вашего** белого списка `/etc/servermind/managed-services`; нет файла — отказ.
- `http.healthcheck` — только `http://127.0.0.1:<порт>/…`, редиректы не выполняются.
- Печатает одну строку JSON `{"ok": …, "op": …, "detail": …}`; код выхода 0 только при успехе. Скрипт короткий — прочитайте его целиком до установки.

Версия: `servermind-op 1`. SHA-256 файла в репозитории на момент написания: `ae4edf307a67451d38a4ee5a68669ffbd992f2e106f3282827fb0b6cc95cfbd4` (сверяйте с `sha256sum` после скачивания; если хеш не совпал — не ставьте).

## Установка (от root на целевом сервере)
```bash
# 1. скачать и ПРОЧИТАТЬ
curl -fsSL -o /tmp/servermind-op https://raw.githubusercontent.com/foecerip2/Test/main/servermind/bootstrap/target/servermind-op
less /tmp/servermind-op
sha256sum /tmp/servermind-op            # сверьте с хешем выше

# 2. установить (владелец root, не доступен для записи другим)
install -m 0755 -o root -g root /tmp/servermind-op /usr/local/sbin/servermind-op

# 3. белый список служб, которые ServerMind МОЖЕТ перезапускать (по одной в строке)
install -d -m 0755 /etc/servermind
printf 'nginx\n' > /etc/servermind/managed-services

# 4. право запускать ТОЛЬКО эту обёртку (подставьте пользователя ServerMind; для root этот шаг не нужен)
echo 'servermind ALL=(root) NOPASSWD: /usr/local/sbin/servermind-op' > /etc/sudoers.d/servermind
chmod 0440 /etc/sudoers.d/servermind && visudo -cf /etc/sudoers.d/servermind

# 5. проверка
sudo -n /usr/local/sbin/servermind-op --version
```

## Включение в ServerMind (все выключатели по умолчанию ВЫКЛ)
1. В `/opt/servermind/env/api.env`: `EXECUTION_ENABLED=true`, затем `docker compose -p servermind --project-directory /opt/servermind/compose up -d api`.
2. Владелец организации: на экране подтверждения плана включить **«Организация»** и **«Этот сервер»**.
3. Сначала **репетиция** плана (обязательна), затем **«Выполнить на сервере…»**. Исполнение идёт ровно один раз на ревизию плана и останавливается на первой ошибке; откат автоматически не выполняется.
4. Аварийно: kill switch платформы (Админка) или `EXECUTION_ENABLED=false`, либо удалите `/etc/sudoers.d/servermind` на сервере.

## Отзыв доступа
Удалите `/etc/sudoers.d/servermind` и `/usr/local/sbin/servermind-op` — ServerMind сразу перестанет мочь что-либо менять. Ключ ServerMind удаляется из `authorized_keys`.

## Что не проверено
Обёртка и вся цепочка проверены автотестами с подставными `systemctl` и тестовым SSH-сервером (настоящий протокол SSH). **На реальном сервере исполнение ни разу не запускалось** (одноразовой ВМ нет): первый реальный запуск проведите на некритичном сервере с белым списком из одной службы.
