#!/usr/bin/env bash
# Проверка обновлений отслеживаемых репозиториев: resolve -> compare -> dispatch -> commit state.
# Запускается из check.yml. Требует: yq, jq, gh, git.
# env: GH_TOKEN (github.token), FORCE (опц.: имена через запятую или "all"), GITHUB_REPOSITORY
set -euo pipefail

FORCE="${FORCE:-}"; FORCE="${FORCE// /}"
failed=0
summary=()

resolve() {  # $1=owner/repo $2=mode $3=branch -> текущий ref (sha или тег)
  case "$2" in
    branch)  gh api "repos/$1/commits/$3" --jq '.sha' ;;
    release) gh api "repos/$1/releases/latest" --jq '.tag_name' ;;
    tag)     git ls-remote --tags --sort=-v:refname "https://github.com/$1.git" \
               | head -n1 | sed -e 's@.*refs/tags/@@' -e 's@\^{}@@' ;;
    *)       echo "unknown trigger mode: $2" >&2; return 1 ;;
  esac
}

n=$(yq '.repos | length' config.yaml)
for i in $(seq 0 $((n - 1))); do
  name=$(yq ".repos[$i].name" config.yaml)
  slug=$(yq ".repos[$i].repo" config.yaml)
  mode=$(yq ".repos[$i].trigger.mode" config.yaml)
  branch=$(yq ".repos[$i].trigger.branch // \"\"" config.yaml)
  platform=$(yq ".repos[$i].platform" config.yaml)

  if ! current=$(resolve "$slug" "$mode" "$branch") || [[ -z "$current" ]]; then
    echo "::warning::$name: не удалось получить текущий ref, пропускаю"
    failed=1
    continue
  fi

  last=$(jq -r --arg n "$name" '.[$n].last // ""' state.json)
  forced=false
  [[ "$FORCE" == "all" || ",$FORCE," == *",$name,"* ]] && forced=true
  if [[ "$current" == "$last" && "$forced" == false ]]; then
    echo "$name: без изменений ($current)"
    continue
  fi

  echo "$name: '$last' -> '$current' (forced=$forced)"
  if ! gh workflow run "build-$platform.yml" -R "$GITHUB_REPOSITORY" \
        -f name="$name" -f build_ref="$current" -f prev_ref="$last"; then
    echo "::error::$name: dispatch build-$platform.yml не удался"
    failed=1
    continue
  fi

  if [[ "$current" != "$last" ]]; then   # форс того же ref не переписывает state
    jq --arg n "$name" --arg cur "$current" --arg prev "$last" --arg t "$(date -u +%FT%TZ)" \
       '.[$n] = {last: $cur, prev: $prev, dispatched_at: $t}' state.json > state.json.tmp
    mv state.json.tmp state.json
    summary+=("$name:${current:0:7}")
  fi
done

# Keepalive: cron публичного репо отключается после 60 дней без активности в репозитории
if [[ ${#summary[@]} -eq 0 ]]; then
  age=$(( $(date +%s) - $(git log -1 --format=%ct) ))
  if (( age > 45 * 86400 )); then
    jq --arg t "$(date -u +%FT%TZ)" '._keepalive = $t' state.json > state.json.tmp
    mv state.json.tmp state.json
    summary+=("keepalive")
  fi
fi

if [[ ${#summary[@]} -gt 0 ]]; then
  git config user.name  "github-actions[bot]"
  git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
  git add state.json
  git commit -m "state: ${summary[*]}"
  for attempt in 1 2 3; do
    git push && break
    [[ $attempt == 3 ]] && { echo "::error::push state.json не удался"; exit 1; }
    git pull --rebase
  done
fi

exit "$failed"
