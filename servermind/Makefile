# ServerMind — команды разработки (web). Backend/infra-цели добавятся в Фазах 2–4.
WEB := apps/web

.PHONY: install dev typecheck test build build-fixtures e2e shots audit test-bootstrap

test-bootstrap: ## установщик и автообновление: shellcheck + тесты на поддельном docker (Docker не нужен)
	bash bootstrap/tests/run.sh

install:
	cd $(WEB) && npm ci

dev:            ## dev-сервер с dev-фикстурами (на экране всегда ribbon «Демо-данные»)
	cd $(WEB) && NEXT_PUBLIC_DEV_FIXTURES=1 npm run dev

typecheck:
	cd $(WEB) && npm run typecheck

test:           ## юнит-тесты
	cd $(WEB) && npm test

build:          ## production-сборка (без фикстур)
	cd $(WEB) && npm run build

build-fixtures: ## сборка с фикстурами для e2e/скриншотов
	cd $(WEB) && npm run build:fixtures

e2e: build build-fixtures
	cd $(WEB) && npx playwright test

shots: build-fixtures
	cd $(WEB) && npm run shots

audit:
	cd $(WEB) && npm audit --omit=dev
