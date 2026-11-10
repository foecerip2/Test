# Подключение AI в ServerMind

Войдите владельцем пространства и откройте **Админка → Подключение AI**. В **Биллинг → Собственные подключения** запросы оплачиваются у провайдера по API-ключу или учитываются в подписке ChatGPT. В режиме **AI-кредиты** действует отдельный биллинг ServerMind.

## Подключение по API-ключу

1. Создайте ключ в кабинете провайдера. Доступны [OpenAI](https://platform.openai.com/api-keys), [Claude Console](https://platform.claude.com/settings/keys) и [DeepSeek](https://platform.deepseek.com/api_keys).
2. В админке нажмите **Подключить** напротив провайдера. Укажите ключ и точное имя модели из кабинета провайдера.
3. Отправьте сообщение в AI-чате сервера. Панель показывает только маску ключа.

## Вход с подпиской ChatGPT на собственном VPS

Для этого способа нужен аккаунт ChatGPT с доступом к использованию плана через Sign in with ChatGPT. OpenAI проверяет план и выбранное рабочее пространство. Для самостоятельно размещённого приложения OpenAI описывает [вход с локальным callback и перенос сессии на VPS по SSH](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms). Выполните шаги после обновления ServerMind.

1. На устройстве, где будете открывать браузер, установите Python 3.12+, клонируйте репозиторий и запустите помощник из каталога `servermind/apps/api`.

   ```bash
   python3 -m venv .venv
   .venv/bin/pip install -r requirements.txt
   .venv/bin/python -m app.modules.ai.chatgpt_login
   ```

   Откройте ссылку на этом же устройстве, войдите в нужный аккаунт ChatGPT и подтвердите разрешения. Помощник выведет список моделей аккаунта и путь к файлу сессии. Для другого аккаунта используйте `--new-account`.

2. С устройства с файлом выполните команду ниже. Замените SSH-адрес, email владельца **ServerMind** и идентификатор модели из списка на свои. Команда предполагает, что SSH-пользователь имеет право запускать Docker на VPS.

   ```bash
   ssh user@your-vps 'docker compose -p servermind --project-directory /opt/servermind/compose exec -T api python -m app.cli chatgpt-import --email owner@example.com --model MODEL' \
     < ~/.config/servermind-chatgpt/session.json
   ```

3. Откройте **Админка → Подключение AI → Подписка ChatGPT**. Проверьте статус и отправьте сообщение в AI-чате. После успешного импорта удалите локальную копию `~/.config/servermind-chatgpt/session.json`. VPS будет обновлять токены сам.
4. Чтобы отключить подписку, нажмите **Отключить аккаунт** в админке. Если отзыв у OpenAI не подтвердился, доступ можно отозвать в настройках ChatGPT.

В режиме собственных подключений подписка используется только аккаунтом ServerMind, к которому её привязали. Если для этого аккаунта подключены оба варианта, чат выбирает подписку. При истечении доступа он предлагает войти заново. Чтобы вернуться к API-ключу, отключите подписку в админке. Claude и DeepSeek в AI-чате подключаются через API-ключи. [Условия Anthropic](https://code.claude.com/docs/en/legal-and-compliance) · [Документация DeepSeek](https://api-docs.deepseek.com/api/deepseek-api/)
