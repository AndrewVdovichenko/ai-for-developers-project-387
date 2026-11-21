# Скиллы

Вендорная копия скиллов [mattpocock/skills](https://github.com/mattpocock/skills) (MIT).
В первом проекте они установлены локально командой
`npx skills@latest add mattpocock/skills -a opencode` в глобальный
`~/.agents/skills`; отсюда скопированы без изменений 47 каталогов по состоянию
на 21 ноября 2026. Копия в репозитории нужна свежему раннеру GitHub Actions:
OpenCode обнаруживает проектные скиллы из `.agents/skills/` после checkout —
и в GitHub Actions, и при локальной работе.

Не включены: handmade-скилл проекта `jsdoc-pattern-generator` и сторонние
установки `use-railway`, `microsoft-foundry`, `find-skills` — они не входят
в набор mattpocock/skills.

Для обновления копий: выполнить установку выше и перезаписать mattpocock-каталоги
из `~/.agents/skills/`.
