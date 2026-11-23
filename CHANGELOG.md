# Changelog

## [0.11.0](https://github.com/AndrewVdovichenko/ai-for-developers-project-387/compare/v0.10.0...v0.11.0) (2026-11-23)


### Новые возможности

* периодический аудит производительности через opencode-audit.yml ([5615d7b](https://github.com/AndrewVdovichenko/ai-for-developers-project-387/commit/5615d7b931ff2bba8d10b8da4c57be24ae524b69))
* периодический аудит производительности через opencode-audit.yml ([3f47b54](https://github.com/AndrewVdovichenko/ai-for-developers-project-387/commit/3f47b5466b114f7cf3228dcb5b05016649bbb71d)), closes [#36](https://github.com/AndrewVdovichenko/ai-for-developers-project-387/issues/36)


### Исправления

* guard ветки без зависимости от schedule payload, правка комментария ([750232e](https://github.com/AndrewVdovichenko/ai-for-developers-project-387/commit/750232ef50da365f755b9181f8261557ed50a11b)), closes [#36](https://github.com/AndrewVdovichenko/ai-for-developers-project-387/issues/36)
* замечания авторевью 5effd60: бюджет таймаутов, строгий cap-check, тесты ([65244ed](https://github.com/AndrewVdovichenko/ai-for-developers-project-387/commit/65244eda249afffe3e167cda03ebe4295643b0a5)), closes [#36](https://github.com/AndrewVdovichenko/ai-for-developers-project-387/issues/36)
* замечания ревью 65244ed: дедуп по лейблу, default-deny, таймауты ([da450c5](https://github.com/AndrewVdovichenko/ai-for-developers-project-387/commit/da450c5b6ee509c2ed36ccdb0995a90215695da3)), closes [#36](https://github.com/AndrewVdovichenko/ai-for-developers-project-387/issues/36)
* строгий гейт находок — отсутствующая метрика не считается пройденной ([5effd60](https://github.com/AndrewVdovichenko/ai-for-developers-project-387/commit/5effd6057e62cf67bf40f34fe223a6f7068763c8)), closes [#36](https://github.com/AndrewVdovichenko/ai-for-developers-project-387/issues/36)

## [0.10.0](https://github.com/AndrewVdovichenko/ai-for-developers-project-387/compare/v0.9.0...v0.10.0) (2026-11-23)


### Новые возможности

* «Записаться ещё» при незакрытом подтверждении прекращает опрос прежней операции ([9ed767d](https://github.com/AndrewVdovichenko/ai-for-developers-project-387/commit/9ed767d78a94f7c6e6084826be9cb8ff154146e9)), closes [#28](https://github.com/AndrewVdovichenko/ai-for-developers-project-387/issues/28)


### Исправления

* сброс при незакрытом подтверждении по замечаниям ревью ([ed7615a](https://github.com/AndrewVdovichenko/ai-for-developers-project-387/commit/ed7615a1d01660dbd99b950dcd6563a4d15d0cc1))

## [0.9.0](https://github.com/AndrewVdovichenko/ai-for-developers-project-387/compare/v0.8.2...v0.9.0) (2026-11-23)


### Новые возможности

* «Записаться ещё» сбрасывает контекст подтверждения целиком ([0cd6eb0](https://github.com/AndrewVdovichenko/ai-for-developers-project-387/commit/0cd6eb078167c62881fd263bf5e3e9c2ed430a3a)), closes [#27](https://github.com/AndrewVdovichenko/ai-for-developers-project-387/issues/27)
* полный сброс подтверждения перебивает и начатую отправку ([82c806f](https://github.com/AndrewVdovichenko/ai-for-developers-project-387/commit/82c806fddb9ca8a784c3e567f0b8511d29868c28)), closes [#27](https://github.com/AndrewVdovichenko/ai-for-developers-project-387/issues/27)

## [0.8.2](https://github.com/AndrewVdovichenko/ai-for-developers-project-387/compare/v0.8.1...v0.8.2) (2026-11-22)


### Исправления

* выдать report-джобу pull-requests: write для PR-комментария ([3cfb660](https://github.com/AndrewVdovichenko/ai-for-developers-project-387/commit/3cfb6602ae868b4d225ab85c80a2636ab9870f73))
* тир-таймауты /oc и отчёт в issue-контексте ([b746b0d](https://github.com/AndrewVdovichenko/ai-for-developers-project-387/commit/b746b0d34a7e00bef82b20372be1c682992da440))
* тир-таймауты /oc и отчёт в issue-контексте ([527856c](https://github.com/AndrewVdovichenko/ai-for-developers-project-387/commit/527856c01ba05360120e463458315943bb97a48c))

## [0.8.1](https://github.com/AndrewVdovichenko/ai-for-developers-project-387/compare/v0.8.0...v0.8.1) (2026-11-22)


### Исправления

* готовить помощник OpenCode только для issue ([#21](https://github.com/AndrewVdovichenko/ai-for-developers-project-387/issues/21)) ([61b0b1b](https://github.com/AndrewVdovichenko/ai-for-developers-project-387/commit/61b0b1b782746534507d6b700af7374bd13521f8))
* извлекать ссылки для авторевью через jq ([#21](https://github.com/AndrewVdovichenko/ai-for-developers-project-387/issues/21)) ([4c50219](https://github.com/AndrewVdovichenko/ai-for-developers-project-387/commit/4c50219732e1816bf219b007e7cc5f830e7b799a))
* ужесточить помощник opencode-pr ([0945ceb](https://github.com/AndrewVdovichenko/ai-for-developers-project-387/commit/0945cebe8586391d88fc3e530e0ddde3a83be428))

## [0.8.0](https://github.com/AndrewVdovichenko/ai-for-developers-project-387/compare/v0.7.2...v0.8.0) (2026-11-22)


### Новые возможности

* добавить автотриаж новых обращений ([c851364](https://github.com/AndrewVdovichenko/ai-for-developers-project-387/commit/c851364ff904c002dba3cfa922e99c88bbc8e23d))
* добавить автотриаж новых обращений ([b294966](https://github.com/AndrewVdovichenko/ai-for-developers-project-387/commit/b294966a963e26781a2d4bfcc1effac7a59047a7)), closes [#16](https://github.com/AndrewVdovichenko/ai-for-developers-project-387/issues/16)

## [0.7.2](https://github.com/AndrewVdovichenko/ai-for-developers-project-387/compare/v0.7.1...v0.7.2) (2026-11-22)


### Исправления

* права и модели CI-агента OpenCode ([#10](https://github.com/AndrewVdovichenko/ai-for-developers-project-387/issues/10)) ([148d0c1](https://github.com/AndrewVdovichenko/ai-for-developers-project-387/commit/148d0c11f1335cec7f1e4c8b11cf7fa2ecb46c51))

## [0.7.1](https://github.com/AndrewVdovichenko/ai-for-developers-project-387/compare/v0.7.0...v0.7.1) (2026-11-22)


### Исправления

* запретить permission-ask у CI-агента OpenCode ([#8](https://github.com/AndrewVdovichenko/ai-for-developers-project-387/issues/8)) ([8ba4458](https://github.com/AndrewVdovichenko/ai-for-developers-project-387/commit/8ba445823024a26cb61364f09e54a49eda888556)), closes [#4](https://github.com/AndrewVdovichenko/ai-for-developers-project-387/issues/4)

## [0.7.0](https://github.com/AndrewVdovichenko/ai-for-developers-project-387/compare/v0.6.1...v0.7.0) (2026-11-21)


### Новые возможности

* интеграция OpenCode-агента в GitHub: воркфлоу команд из комментариев ([#5](https://github.com/AndrewVdovichenko/ai-for-developers-project-387/issues/5)) ([088d769](https://github.com/AndrewVdovichenko/ai-for-developers-project-387/commit/088d76944e5c6804c6be2bd08aab515f0f66efde)), closes [#4](https://github.com/AndrewVdovichenko/ai-for-developers-project-387/issues/4)
