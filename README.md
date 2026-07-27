# repos-ci-factory

Персональная CI-фабрика: раз в день проверяет отслеживаемые GitHub-репозитории, при обновлениях
собирает приложения (Android APK на `ubuntu-latest`, macOS app на `macos-26`) и отправляет
артефакты в Telegram-канал.

## Как это работает

```
config.yaml ──► check.yml (cron 05:07 UTC ежедневно)
                  │  текущий SHA/тег апстрима  ⟷  state.json
                  │  изменилось → dispatch build-<platform>.yml
                  │  commit state.json (в момент dispatch)
                  ▼
build-android.yml / build-macos.yml
  сборка → подпись → scripts/tg_send.sh
    ≤ 45 МБ  → файлом в канал (sendDocument)
    больше   → GitHub Release здесь + ссылка в канал
  падение   → 🔴 сообщение в канал со ссылкой на лог
```

## Добавить репозиторий

Один блок в [config.yaml](config.yaml) (см. существующие как образец):

```yaml
  - name: myapp                # уникальное имя (ключ state.json, значение для force=)
    repo: owner/repo
    display: MyApp
    platform: android          # android | macos
    trigger:
      mode: branch             # branch | release | tag
      branch: main
    build: { ... }             # рецепт сборки, поля зависят от platform
    artifact: { ... }
```

Первый билд произойдёт на следующем дневном тике, или сразу:

```bash
gh workflow run check.yml -R nvtoroy/repos-ci-factory -f force=myapp
```

## Секреты (Settings → Secrets → Actions)

| Секрет | Что это |
|---|---|
| `TELEGRAM_BOT_TOKEN` | токен бота (бот — админ канала с правом публикации) |
| `TELEGRAM_CHAT_ID` | id канала (`@username` или `-100…`) |
| `ANDROID_KEYSTORE_B64` | keystore для подписи APK, base64 |
| `ANDROID_KEY_ALIAS` / `ANDROID_KEYSTORE_PASSWORD` / `ANDROID_KEY_PASSWORD` | параметры keystore |

⚠️ **Keystore незаменим**: локальный оригинал — `~/keys/repos-ci-factory.jks` (+ пароль рядом).
Сделайте резервную копию. Потеря ключа разорвёт цепочку обновлений APK (новые сборки перестанут
ставиться поверх старых без удаления).

## Семантика ретраев

`state.json` фиксирует SHA **в момент dispatch**. Упавшая сборка не ретраится автоматически на том
же SHA (чтобы сломанный апстрим-коммит не долбил канал ошибками). Восстановление:

- re-run упавшего запуска в Actions (подхватит исправления config.yaml — factory чекаутится с `main`), или
- `gh workflow run check.yml -f force=<name>` — пересборка текущего HEAD.

## Обслуживание

- **Расписание**: строка `cron` в [check.yml](.github/workflows/check.yml).
- **Releases-прунинг**: артефакты > 45 МБ копятся в Releases; удалять по мере надобности:
  `gh release list -R nvtoroy/repos-ci-factory` → `gh release delete <tag> --cleanup-tag`.
- **Keepalive**: cron публичных репо отключается после 60 дней без активности; check.yml сам
  коммитит `_keepalive` в state.json, если 45 дней не было коммитов. Если GitHub всё же отключил
  workflow (после долгого простоя): `gh workflow enable check.yml`.
- **Xcode/раннеры**: bitchat требует Xcode 26.x (`build.xcode: "26"` в config.yaml); при переходе
  апстрима на Xcode 27 поменять на `"27"` и, при необходимости, `runs-on` на `macos-27`.
