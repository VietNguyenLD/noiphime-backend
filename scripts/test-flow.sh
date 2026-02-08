#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_BASE_URL="${API_BASE_URL:-http://localhost:4000}"
SOURCE="${1:-kkphim}"
PAGE="${2:-1}"

log() {
  printf "\n[%s] %s\n" "$(date '+%H:%M:%S')" "$1"
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing command: $1" >&2
    exit 1
  }
}

parse_json() {
  local expr="$1"
  node -e "const fs=require('fs');const input=fs.readFileSync(0,'utf8');const data=JSON.parse(input);const out=($expr);if(out===undefined||out===null){process.exit(2);}if(typeof out==='object'){console.log(JSON.stringify(out));}else{console.log(String(out));}"
}

need_cmd docker
need_cmd curl
need_cmd node

log "Check docker services"
docker compose -f "$ROOT_DIR/docker-compose.yml" ps api db redis >/dev/null

log "Health check"
HEALTH_JSON="$(curl -sSf "$API_BASE_URL/health")"
printf '%s\n' "$HEALTH_JSON"
HEALTH_STATUS="$(printf '%s' "$HEALTH_JSON" | parse_json "data.status")"
DB_STATUS="$(printf '%s' "$HEALTH_JSON" | parse_json "data.db")"
if [[ "$HEALTH_STATUS" != "ok" || "$DB_STATUS" != "ok" ]]; then
  echo "Health failed: status=$HEALTH_STATUS db=$DB_STATUS" >&2
  exit 1
fi

log "Enqueue discover source=$SOURCE page=$PAGE"
DISCOVER_JSON="$(curl -sSf -X POST "$API_BASE_URL/crawl/$SOURCE/discover?page=$PAGE")"
printf '%s\n' "$DISCOVER_JSON"
QUEUED="$(printf '%s' "$DISCOVER_JSON" | parse_json "data.queued")"
if [[ "$QUEUED" != "true" ]]; then
  echo "Discover was not queued" >&2
  exit 1
fi

log "Wait workers process jobs"
sleep 5

log "Fetch latest source_item from DB"
LATEST_ROW="$(docker compose -f "$ROOT_DIR/docker-compose.yml" exec -T db \
  psql -U movie_user -d movie_db -At -F '|' -c \
  "SELECT si.id, si.external_id, si.crawl_status FROM source_items si JOIN sources s ON s.id = si.source_id WHERE s.code = '$SOURCE' AND si.payload <> '{}'::jsonb ORDER BY si.updated_at DESC LIMIT 1;")"

if [[ -z "$LATEST_ROW" ]]; then
  echo "No source_item found for source=$SOURCE" >&2
  exit 1
fi

SOURCE_ITEM_ID="${LATEST_ROW%%|*}"
REST="${LATEST_ROW#*|}"
EXTERNAL_ID="${REST%%|*}"
CRAWL_STATUS="${LATEST_ROW##*|}"
printf 'source_item_id=%s external_id=%s crawl_status=%s\n' "$SOURCE_ITEM_ID" "$EXTERNAL_ID" "$CRAWL_STATUS"

log "Sync source_item_id=$SOURCE_ITEM_ID"
SYNC_JSON="$(curl -sSf -X POST "$API_BASE_URL/sync/source-items/$SOURCE_ITEM_ID")"
printf '%s\n' "$SYNC_JSON"
MOVIE_ID="$(printf '%s' "$SYNC_JSON" | parse_json "data.movieId")"

log "Get movie slug by movie_id=$MOVIE_ID"
MOVIE_ROW="$(docker compose -f "$ROOT_DIR/docker-compose.yml" exec -T db \
  psql -U movie_user -d movie_db -At -F '|' -c \
  "SELECT id, slug FROM movies WHERE id = $MOVIE_ID LIMIT 1;")"
if [[ -z "$MOVIE_ROW" ]]; then
  echo "Movie not found after sync: movie_id=$MOVIE_ID" >&2
  exit 1
fi
MOVIE_SLUG="${MOVIE_ROW##*|}"
printf 'movie_id=%s slug=%s\n' "$MOVIE_ID" "$MOVIE_SLUG"

log "Get movie detail"
MOVIE_JSON="$(curl -sSf "$API_BASE_URL/movies/$MOVIE_SLUG")"
printf '%s\n' "$MOVIE_JSON" | parse_json "({id:data.id,slug:data.slug,title:data.title})"

log "Get episodes"
EPISODES_JSON="$(curl -sSf "$API_BASE_URL/movies/$MOVIE_SLUG/episodes")"
FIRST_EPISODE_ID="$(printf '%s' "$EPISODES_JSON" | parse_json "(data.episodes && data.episodes[0] ? data.episodes[0].id : null)")"
printf 'first_episode_id=%s\n' "$FIRST_EPISODE_ID"

log "Get streams for first episode"
STREAMS_JSON="$(curl -sSf "$API_BASE_URL/episodes/$FIRST_EPISODE_ID/streams")"
printf '%s\n' "$STREAMS_JSON" | parse_json "({servers:(data.servers||[]).length,streams:(data.streams||[]).length})"

log "Flow test PASSED"
printf 'source=%s source_item_id=%s movie_id=%s slug=%s episode_id=%s\n' \
  "$SOURCE" "$SOURCE_ITEM_ID" "$MOVIE_ID" "$MOVIE_SLUG" "$FIRST_EPISODE_ID"
