#!/usr/bin/env bash
# Сообщение в канал о падении сборки.
# env: TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID NAME DISPLAY PLATFORM BRANCH BUILD_REF RUN_URL
set -euo pipefail

esc() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

TEXT="🔴 <b>$(printf '%s' "${DISPLAY:-$NAME}" | esc)</b> ${PLATFORM}: сборка упала
<code>${BRANCH:-?} @ ${BUILD_REF:0:7}</code>
Лог: ${RUN_URL}
Повтор: re-run упавшего запуска или <code>gh workflow run check.yml -f force=${NAME}</code>"

curl -sS --retry 3 --retry-delay 10 --retry-all-errors \
  --data-urlencode chat_id="$TELEGRAM_CHAT_ID" --data-urlencode parse_mode=HTML \
  --data-urlencode text="$TEXT" \
  "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" | jq -e '.ok' > /dev/null
echo "Уведомление о падении отправлено"
