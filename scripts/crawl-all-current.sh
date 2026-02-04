#!/usr/bin/env bash
set -euo pipefail

API_BASE_URL="${API_BASE_URL:-http://localhost:3000}"
TARGET_SOURCE="${1:-all}"          # all | ophim | kkphim
MAX_PAGES_OVERRIDE="${2:-}"        # optional: giới hạn page để test nhanh
RETRY_PER_PAGE="${RETRY_PER_PAGE:-3}"
REQUEST_DELAY_SEC="${REQUEST_DELAY_SEC:-0.03}"

OPHIM_LIST_URL="${OPHIM_LIST_URL:-https://ophim1.com/danh-sach/phim-moi-cap-nhat?page=1}"
KKPHIM_LIST_URL="${KKPHIM_LIST_URL:-https://phimapi.com/danh-sach/phim-moi-cap-nhat?page=1}"

log() {
  printf "[%s] %s\n" "$(date '+%H:%M:%S')" "$1"
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing command: $1" >&2
    exit 1
  }
}

json_get() {
  local expr="$1"
  node -e "const fs=require('fs');const s=fs.readFileSync(0,'utf8');const j=JSON.parse(s);const v=($expr);if(v===undefined||v===null)process.exit(2);process.stdout.write(String(v));"
}

fetch_total_pages() {
  local list_url="$1"
  curl -sSf "$list_url" | json_get "j.pagination?.totalPages ?? j.data?.pagination?.totalPages ?? j.data?.params?.pagination?.totalPages"
}

check_api_ready() {
  local health
  health="$(curl -sSf "$API_BASE_URL/health")"
  local status db
  status="$(printf '%s' "$health" | json_get "j.status ?? j.data?.status")"
  db="$(printf '%s' "$health" | json_get "j.db ?? j.data?.db")"
  if [[ "$status" != "ok" || "$db" != "ok" ]]; then
    echo "API not ready: status=$status db=$db" >&2
    exit 1
  fi
}

enqueue_page() {
  local source="$1"
  local page="$2"
  local attempt=1

  while (( attempt <= RETRY_PER_PAGE )); do
    local resp
    if resp="$(curl -sS -f -X POST "$API_BASE_URL/crawl/$source/discover?page=$page")"; then
      if [[ "$resp" == *"\"queued\":true"* ]]; then
        return 0
      fi
    fi
    ((attempt++))
    sleep 0.2
  done

  return 1
}

crawl_source() {
  local source="$1"
  local list_url="$2"
  local total_pages
  total_pages="$(fetch_total_pages "$list_url")"

  if [[ -n "$MAX_PAGES_OVERRIDE" ]]; then
    if [[ "$MAX_PAGES_OVERRIDE" =~ ^[0-9]+$ ]] && (( MAX_PAGES_OVERRIDE > 0 )) && (( MAX_PAGES_OVERRIDE < total_pages )); then
      total_pages="$MAX_PAGES_OVERRIDE"
    fi
  fi

  log "Start source=$source totalPages=$total_pages"
  local ok=0 fail=0

  for ((page=1; page<=total_pages; page++)); do
    if enqueue_page "$source" "$page"; then
      ((ok+=1))
    else
      ((fail+=1))
      echo "Failed enqueue: source=$source page=$page" >&2
    fi

    if (( page % 50 == 0 || page == total_pages )); then
      log "Progress source=$source page=$page/$total_pages ok=$ok fail=$fail"
    fi
    sleep "$REQUEST_DELAY_SEC"
  done

  log "Done source=$source ok=$ok fail=$fail"
}

need_cmd curl
need_cmd node
check_api_ready

case "$TARGET_SOURCE" in
  all)
    crawl_source "ophim" "$OPHIM_LIST_URL"
    crawl_source "kkphim" "$KKPHIM_LIST_URL"
    ;;
  ophim)
    crawl_source "ophim" "$OPHIM_LIST_URL"
    ;;
  kkphim)
    crawl_source "kkphim" "$KKPHIM_LIST_URL"
    ;;
  *)
    echo "Invalid source: $TARGET_SOURCE (use: all | ophim | kkphim)" >&2
    exit 1
    ;;
esac

log "Enqueue completed. Check worker logs: docker compose logs -f api"
