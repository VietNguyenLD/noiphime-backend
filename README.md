# Movie Backend - Hướng dẫn chạy dự án

## Tài liệu API
- API documentation: `doc/API_DOCUMENTATION.md`
- Postman collection: `doc/Movie-Backend.postman_collection.json`

## Yêu cầu
- Node.js + npm (khuyến nghị Node 18+)
- Docker + Docker Compose (nếu chạy bằng Docker)

## Cách 1: Chạy bằng Docker (khuyến nghị)
1. Mở terminal tại thư mục `movie-backend`.
2. Chạy:

```bash
docker compose up --build
docker compose logs -f api
```

Mặc định các service:
- API chạy tại `http://localhost:3000`
- Postgres chạy tại `localhost:5432`
- Redis chạy tại `localhost:6379`
- PgAdmin chạy tại `http://localhost:5050`

Ghi chú:
- Docker Compose dùng file `.env` cho thông tin Postgres và PgAdmin.
- API container dùng file `.env.docker`.

## Cách 2: Chạy local (không Docker)
1. Cài dependencies:

```bash
npm install
```

2. Tạo hoặc cập nhật file `.env` theo mẫu sau (có thể copy từ `.env.docker` và đổi host về `localhost`):

```env
PORT=3000
DB_HOST=localhost
DB_PORT=5432
DB_USER=movie_user
DB_PASSWORD=movie_pass
DB_NAME=movie_db
REDIS_HOST=localhost
REDIS_PORT=6379

OPHIM_BASE_URL=https://ophim1.com
OPHIM_LIST_PATH=/danh-sach/phim-moi-cap-nhat?page={page}
OPHIM_DETAIL_PATH=/phim/{slug}

KKPHIM_BASE_URL=https://phimapi.com
KKPHIM_LIST_PATH=/danh-sach/phim-moi-cap-nhat
KKPHIM_DETAIL_PATH=/phim/{slug}
```

3. Khởi chạy Postgres và Redis (tự cài hoặc dùng Docker riêng).
4. Khởi tạo schema DB (nếu chưa có):

```bash
psql -h localhost -U movie_user -d movie_db -f db/00_schema.sql
psql -h localhost -U movie_user -d movie_db -f db/01_search_triggers.sql
```

5. Chạy app ở chế độ dev:

```bash
npm run start:dev
```

## Seed dữ liệu (tuỳ chọn)
Seeder hiện tại chỉ tạo/cập nhật bảng `sources` với:
- `ophim` -> `https://ophim1.com`
- `kkphim` -> `https://phimapi.com`

Sau khi DB đã sẵn sàng:

```bash
npm run seed
```

## Build & chạy production (tuỳ chọn)
```bash
npm run build
npm run start
```

## Health check
Mở:

```text
http://localhost:3000/health
```

Nếu mọi thứ ổn, trả về:

```json
{"status":"ok","db":"ok"}
```

## Test full flow
Chạy script kiểm tra end-to-end: health -> crawl discover -> sync -> movie -> episodes -> streams

```bash
./scripts/test-flow.sh
```

Tuỳ chọn source/page:

```bash
./scripts/test-flow.sh ophim 1
```

## Crawl toàn bộ dữ liệu hiện tại của nguồn
Script tự lấy `totalPages` mới nhất từ API nguồn và enqueue toàn bộ discover pages:

```bash
./scripts/crawl-all-current.sh
```

Chạy riêng từng nguồn:

```bash
./scripts/crawl-all-current.sh ophim
./scripts/crawl-all-current.sh kkphim
```

Test nhanh với giới hạn số trang:

```bash
./scripts/crawl-all-current.sh ophim 10
```

Theo dõi worker:

```bash
docker compose logs -f api
```
