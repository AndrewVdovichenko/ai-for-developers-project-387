# Работа с проектом

## Команды

- Окружение: `mise trust`, `mise install`, `mise run setup`.
- Разработка: `mise run dev`; управление серверами: `mise run dev:status`, `mise run dev:logs`, `mise run dev:stop`.
- Тесты: `mise run test` (Vitest: API-smoke) и `mise run test:e2e` (Playwright e2e, со сборкой фронтенда). Браузер ставится `mise run setup`; разово обновить — `yarn playwright install chromium`.
- База данных: `mise run db:start`, `db:migrate`, `db:status`, `db:stop` (Apple Container); пароль Владельца — `mise run owner:password`. Тест персистентности — `mise run test:persistence`, требует Apple Container.
- Генерация OpenAPI и SDK: `mise run generate`.
- Сборка: `mise run build`.
- Все проверки: `mise run check`; форматирование: `mise run fix`.
- Проверка уязвимостей (нужна сеть): `mise run security:audit`.

## Устройство

- `apps/api` — бекенд Fastify; `apps/web` — фронтенд React/Vite/Mantine.
- `packages/api-client` — SDK, используемый фронтендом и HTTP-тестом.
- `contracts/main.tsp` — источник API-контракта.
- `.agents/skills` — вендорные скиллы агента (см. README каталога); `.github/workflows/opencode.yml` — ответ агента на команды `/oc` в комментариях (см. README секцию «Агент в GitHub»).

## Правила

- Каждую имплементацию выполняй в отдельной ветке и отдельном git worktree. В конце работы создай Pull Request.

- Issue в трекере (`docs/agents/issue-tracker.md`) заводи на юнит-задачу: фичу, этап, рефакторинг или баг, взятые в работу без готового тикета; коммить со ссылкой на номер. Мелкие правки коммить без Issue. Прокладку маршрута из этапов делай через `/wayfinder` (Issue-карта + суб-задачи), а не разовыми тикетами.
- Изменения API начинай с TypeSpec; генерируй OpenAPI и SDK и коммить результаты вместе с контрактом.
- Компиляция приложения использует TS 7. Корневой `typescript` — совместимый API TS 6 для Hey API и dependency-cruiser; корневой `tsc` предоставляет алиас `@typescript/native`.
- После изменений кода выполни `mise run check`; если проверка недоступна, укажи причину в результате работы.
- Типографика русских текстов: не оставляй висячие предлоги, союзы и частицы («в», «на», «у», «с», «по», «о», «об», «и», «а», «но», «или» и т. п.) в конце строки — отделяй их от следующего слова неразрывным пробелом (U+00A0). В JSX — `&nbsp;` или `{'\u00A0'}`, в Markdown и коде — символ U+00A0 целиком.

## Коммиты

- Conventional Commits: `feat: …`, `fix: …`, `chore: …`, `docs: …`, `ci: …`, `test: …`; описание на русском. В теле кратко перечисли изменения.
- Создавай коммиты с `git commit --no-gpg-sign …`.

## Agent skills

### Issue tracker

Issues живут в GitHub Issues этого репозитория (через `gh` CLI). Подробности: `docs/agents/issue-tracker.md`.

### Triage labels

Дефолтный словарь из пяти канонических ролей (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). Подробности: `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` + `docs/adr/` в корне репозитория. Подробности: `docs/agents/domain.md`.
