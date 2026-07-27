#!/usr/bin/env bash
# Отправка артефакта в Telegram-канал. До лимита — файлом (sendDocument);
# больше лимита или при ошибке отправки — GitHub Release на фабрике + сообщение со ссылкой.
# usage: tg_send.sh <file>
# env: TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID GH_TOKEN GITHUB_REPOSITORY GITHUB_SERVER_URL GITHUB_RUN_ID
#      NAME DISPLAY PLATFORM SLUG BRANCH BUILD_REF PREV_REF VERSION SUBJECT NOTE MAX_DIRECT_MB
set -euo pipefail

FILE="$1"
API="https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}"

esc() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

SHA7=${BUILD_REF:0:7}
SUBJ=$(printf '%s' "${SUBJECT:-}" | head -c 160 | esc)

# Подпись собирается из шаблона repos[].telegram.caption (config.yaml).
# Плейсхолдеры: {display} {platform} {version} {branch} {sha7} {subject} {compare_url} {run_url} {note}
TPL=$(yq ".repos[] | select(.name == \"${NAME}\") | .telegram.caption // \"\"" factory/config.yaml 2>/dev/null || true)
if [[ -z "$TPL" ]]; then
  TPL=$'📦 <b>{display}</b> {version}\n{note}'
fi
COMPARE_URL=""
[[ -n "${PREV_REF:-}" ]] && COMPARE_URL="https://github.com/${SLUG}/compare/${PREV_REF:0:12}...${BUILD_REF:0:12}"
RUN_URL="${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}"

CAPTION=$TPL
CAPTION=${CAPTION//\{display\}/$(printf '%s' "$DISPLAY" | esc)}
CAPTION=${CAPTION//\{platform\}/$PLATFORM}
CAPTION=${CAPTION//\{version\}/$(printf '%s' "$VERSION" | esc)}
CAPTION=${CAPTION//\{branch\}/$(printf '%s' "${BRANCH:-}" | esc)}
CAPTION=${CAPTION//\{sha7\}/$SHA7}
CAPTION=${CAPTION//\{subject\}/$SUBJ}
CAPTION=${CAPTION//\{compare_url\}/$COMPARE_URL}
CAPTION=${CAPTION//\{run_url\}/$RUN_URL}
NOTE_LINE=""
if [[ -n "${NOTE:-}" ]]; then NOTE_LINE="⚠️ $(printf '%s' "$NOTE" | esc)"; fi
CAPTION=${CAPTION//\{note\}/$NOTE_LINE}
CAPTION=$(printf '%s' "$CAPTION" | sed '/^[[:space:]]*$/d')   # пустые строки от незаполненных плейсхолдеров

size=$(wc -c < "$FILE")
max=$(( ${MAX_DIRECT_MB:-45} * 1024 * 1024 ))

send_document() {
  local resp
  resp=$(curl -sS --retry 3 --retry-delay 10 --retry-all-errors \
    -F chat_id="$TELEGRAM_CHAT_ID" -F parse_mode=HTML \
    -F caption="$CAPTION" -F document=@"$FILE" "$API/sendDocument")
  jq -e '.ok' <<< "$resp" > /dev/null || { echo "sendDocument: $resp" >&2; return 1; }
}

send_link_via_release() {
  local tag url resp
  tag="${NAME}-$(date -u +%Y%m%d)-${SHA7}"
  if gh release view "$tag" -R "$GITHUB_REPOSITORY" > /dev/null 2>&1; then
    gh release upload "$tag" "$FILE" -R "$GITHUB_REPOSITORY" --clobber
  else
    gh release create "$tag" "$FILE" -R "$GITHUB_REPOSITORY" --title "$tag" --latest=false \
      --notes "Automated build of ${SLUG}@${BUILD_REF}"
  fi
  url="https://github.com/${GITHUB_REPOSITORY}/releases/download/${tag}/$(basename "$FILE")"
  resp=$(curl -sS --retry 3 --retry-delay 10 --retry-all-errors \
    --data-urlencode chat_id="$TELEGRAM_CHAT_ID" --data-urlencode parse_mode=HTML \
    --data-urlencode text="$CAPTION
⬇️ $(( (size + 1048575) / 1048576 )) MB: ${url}" "$API/sendMessage")
  jq -e '.ok' <<< "$resp" > /dev/null || { echo "sendMessage: $resp" >&2; return 1; }
}

if (( size <= max )); then
  send_document || { echo "sendDocument не прошёл — fallback на Release-ссылку"; send_link_via_release; }
else
  send_link_via_release
fi
echo "OK: доставлено ($(basename "$FILE"), $size байт)"
