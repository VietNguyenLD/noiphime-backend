# Movie Backend API Documentation

## Base URL
- Local: `http://localhost:3000`

## Response Format
- API trả JSON trực tiếp từ service/controller.
- Một số endpoint trả object có field `data` + `meta`, một số trả object thường (`{ queued: true }`, `{ status: "ok" }`, ...).

## 1) Health

### GET `/health`
Kiểm tra trạng thái API và database.

Response mẫu:
```json
{
  "status": "ok",
  "db": "ok"
}
```

`db` có thể là:
- `ok`
- `down`

---

## 1.1) Menu

### GET `/menu`
Lấy dữ liệu menu header (loại phim, thể loại, quốc gia).

Response mẫu:
```json
{
  "types": [
    { "key": "single", "label": "Phim lẻ" },
    { "key": "series", "label": "Phim bộ" }
  ],
  "genres": [
    { "id": 1, "name": "Action", "slug": "action" }
  ],
  "countries": [
    { "id": 1, "name": "Japan", "code": "JP" }
  ]
}
```

---

## 2) Movies

### GET `/movies`
Lấy danh sách phim (có phân trang + filter + search).

Query params:
- `page` (number, mặc định `1`, min `1`)
- `limit` (number, mặc định `20`, min `1`, max `50`)
- `sort` (`popular` | `new` | `updated`)
- `type` (`single` | `series`)
- `year` (number)
- `status` (`ongoing` | `completed` | `upcoming`)
- `genre` (string, slug genre)
- `country` (string, country code hoặc name)
- `q` (string, full-text search)

Response mẫu:
```json
{
  "data": [
    {
      "id": 1,
      "slug": "abc",
      "title": "Movie A"
    }
  ],
  "meta": {
    "page": 1,
    "limit": 20,
    "total": 120,
    "totalPages": 6
  }
}
```

### GET `/movies/:slug`
Lấy chi tiết 1 phim theo slug.

Path params:
- `slug` (string)

Response mẫu:
```json
{
  "id": 1,
  "slug": "movie-a",
  "title": "Movie A",
  "profile_sizes": {
    "h632": "https://image.tmdb.org/t/p/h632",
    "original": "https://image.tmdb.org/t/p/original",
    "w185": "https://image.tmdb.org/t/p/w185",
    "w45": "https://image.tmdb.org/t/p/w45"
  },
  "genres": [],
  "countries": [],
  "tags": [],
  "cast": []
}
```

Lỗi:
- `404` nếu không tìm thấy phim.

### GET `/movies/:slug/episodes`
Lấy danh sách season + episode của phim.

Path params:
- `slug` (string)

Response mẫu:
```json
{
  "seasons": [
    {
      "id": 10,
      "movie_id": 1,
      "season_number": 1,
      "name": "Season 1"
    }
  ],
  "episodes": [
    {
      "id": 100,
      "movie_id": 1,
      "name": "Tập 1",
      "episode_number": 1
    }
  ]
}
```

Lỗi:
- `404` nếu không tìm thấy phim.

### GET `/episodes/:id/streams`
Lấy server/stream của episode.

Path params:
- `id` (episode id)

Response mẫu:
```json
{
  "servers": [],
  "streams": []
}
```

---

## 3) Crawl

### POST `/crawl/:source/discover?page=1`
Enqueue job crawl danh sách phim từ nguồn.

Path params:
- `source`: `ophim` hoặc `kkphim`

Query params:
- `page` (number, mặc định `1`)

Response mẫu:
```json
{
  "queued": true
}
```

Lỗi:
- Có thể lỗi nếu source chưa được cấu hình hoặc chưa seed `sources`.

### POST `/crawl/:source/detail/:externalId`
Enqueue job crawl chi tiết theo `externalId`.

Path params:
- `source`: `ophim` hoặc `kkphim`
- `externalId`: id từ nguồn crawl

Response mẫu:
```json
{
  "queued": true
}
```

---

## 4) Collections

### GET `/collection/list`
Lấy danh sách collections (có phân trang). Mỗi collection trả kèm danh sách movies theo filter.

Query params:
- `page` (number, mặc định `1`, min `1`)
- `limit` (number, mặc định `10`, min `1`, max `50`)

Response mẫu:
```json
{
  "collections": [
    {
      "_id": "1",
      "name": "Phim Hàn Quốc mới",
      "slug": "phim-han-quoc-moi",
      "order": 1,
      "random_data": false,
      "type": 2,
      "filter": {
        "country_code": ["KR"],
        "status": "On Going",
        "type": "",
        "top_views": "",
        "limit": "20",
        "sort_by": "updated_at",
        "order": "-1"
      },
      "movies": [
        {
          "_id": "123",
          "public_id": "movie-a",
          "original_title": "Movie A",
          "english_title": "Movie A",
          "title": "Movie A",
          "slug": "movie-a",
          "overview": "Plot...",
          "release_date": "2025-01-01",
          "quality": "HD",
          "rating": 8.1,
          "runtime": 120,
          "type": "series",
          "origin_country": ["KR"],
          "status": "ongoing",
          "latest_season": 2,
          "imdb_rating": null,
          "latest_episode": 10,
          "year": 2025,
          "genres": [
            { "id": 1, "name": "Hành Động", "slug": "hanh-dong" }
          ],
          "images": {
            "poster": "https://...",
            "backdrop": "https://..."
          }
        }
      ]
    }
  ],
  "totalPages": 4
}
```

---

## 5) Sync

### POST `/sync/source-items/:id`
Đồng bộ 1 `source_item` vào bảng `movies` và các bảng liên quan.

Path params:
- `id` (source_item id)

Response mẫu:
```json
{
  "movieId": 123,
  "matchedBy": "imdb"
}
```

`matchedBy` có thể là:
- `imdb`
- `tmdb`
- `title_year`
- `other`

Lỗi:
- `404` nếu không tìm thấy source item.

---

## Error Codes Thường Gặp
- `400 Bad Request`: query/path không hợp lệ (ValidationPipe + class-validator).
- `404 Not Found`: resource không tồn tại.
- `500 Internal Server Error`: lỗi xử lý server/job.

---

## Quick Test Commands
```bash
curl -s http://localhost:3000/health
curl -s "http://localhost:3000/movies?page=1&limit=20"
curl -s -X POST "http://localhost:3000/crawl/ophim/discover?page=1"
curl -s -X POST "http://localhost:3000/crawl/kkphim/discover?page=1"
curl -s -X POST "http://localhost:3000/sync/source-items/1"
```
