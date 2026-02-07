#!/usr/bin/env bash
set -euo pipefail

API_BASE_URL="${API_BASE_URL:-http://localhost:3000}"
TARGET_SOURCE="${1:-all}"          # all | ophim | kkphim
MAX_PAGES_OVERRIDE="${2:-}"        # optional: giới hạn page để test nhanh
RETRY_PER_PAGE="${RETRY_PER_PAGE:-3}"
REQUEST_DELAY_SEC="${REQUEST_DELAY_SEC:-0.03}"
SYNC_AFTER="${SYNC_AFTER:-0}"      # 1 = sync source_items -> movies after crawl
SYNC_LIMIT="${SYNC_LIMIT:-500}"    # max source_items to sync per source (number or "all")
INLINE_PROCESSING="${INLINE_PROCESSING:-0}" # 1 = call crawl endpoints inline (no queue)

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

db_query() {
  local sql="$1"
  if command -v docker >/dev/null 2>&1 && docker compose ps db >/dev/null 2>&1; then
    docker compose exec -T db psql -U "${DB_USER:-movie_user}" -d "${DB_NAME:-movie_db}" -At -c "$sql"
    return $?
  fi

  if command -v psql >/dev/null 2>&1; then
    PGPASSWORD="${DB_PASSWORD:-movie_pass}" \
      psql -h "${DB_HOST:-localhost}" -p "${DB_PORT:-5432}" -U "${DB_USER:-movie_user}" -d "${DB_NAME:-movie_db}" -At -c "$sql"
    return $?
  fi

  echo "Missing command: docker or psql (needed for sync-after)" >&2
  return 1
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
    local inline_q=""
    if [[ "$INLINE_PROCESSING" == "1" ]]; then
      inline_q="&inline=1"
    fi
    if resp="$(curl -sS -f -X POST "$API_BASE_URL/crawl/$source/discover?page=$page$inline_q")"; then
      if [[ "$INLINE_PROCESSING" == "1" ]]; then
        return 0
      fi
      if [[ "$resp" == *"\"queued\":true"* ]]; then
        return 0
      fi
    fi
    ((attempt++))
    sleep 0.2
  done

  return 1
}

fill_missing_payload() {
  local source="$1"
  if [[ "$SYNC_AFTER" != "1" ]]; then
    return 0
  fi

  log "Fetch detail inline for empty payloads: source=$source limit=$SYNC_LIMIT"
  local limit_sql ids external_id ok=0 fail=0
  if [[ "$SYNC_LIMIT" == "all" ]]; then
    limit_sql=""
  else
    limit_sql="LIMIT $SYNC_LIMIT"
  fi

  ids="$(db_query "SELECT si.external_id
                   FROM source_items si
                   JOIN sources s ON s.id = si.source_id
                   WHERE s.code = '$source'
                     AND si.payload = '{}'::jsonb
                   ORDER BY si.updated_at DESC
                   $limit_sql;")" || {
    echo "Failed to query DB for empty payloads" >&2
    return 1
  }

  if [[ -z "$ids" ]]; then
    log "No empty payloads to fetch for source=$source"
    return 0
  fi

  while IFS= read -r external_id; do
    [[ -z "$external_id" ]] && continue
    if curl -sS -f -X POST "$API_BASE_URL/crawl/$source/detail/$external_id?inline=1" >/dev/null; then
      ((ok+=1))
    else
      ((fail+=1))
      echo "Failed detail: source=$source external_id=$external_id" >&2
    fi
  done <<< "$ids"

  log "Detail fetch done source=$source ok=$ok fail=$fail"
}

sync_pending_items() {
  local source="$1"
  if [[ "$SYNC_AFTER" != "1" ]]; then
    return 0
  fi

  log "Sync after crawl: source=$source limit=$SYNC_LIMIT"
  local sql ids id ok=0 fail=0
  local limit_sql
  if [[ "$SYNC_LIMIT" == "all" ]]; then
    limit_sql=""
  else
    limit_sql="LIMIT $SYNC_LIMIT"
  fi

  sql="SELECT si.id
       FROM source_items si
       JOIN sources s ON s.id = si.source_id
       LEFT JOIN movie_source_map msm ON msm.source_item_id = si.id
       WHERE s.code = '$source'
         AND si.payload <> '{}'::jsonb
         AND msm.id IS NULL
       ORDER BY si.updated_at DESC
       $limit_sql;"

  ids="$(db_query "$sql")" || {
    echo "Failed to query DB for sync items" >&2
    return 1
  }

  if [[ -z "$ids" ]]; then
    log "No pending source_items to sync for source=$source"
    return 0
  fi

  while IFS= read -r id; do
    [[ -z "$id" ]] && continue
    if curl -sS -f -X POST "$API_BASE_URL/sync/source-items/$id" >/dev/null; then
      ((ok+=1))
    else
      ((fail+=1))
      echo "Failed sync: source_item_id=$id" >&2
    fi
  done <<< "$ids"

  log "Sync done source=$source ok=$ok fail=$fail"
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
  fill_missing_payload "$source"
  sync_pending_items "$source"
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
