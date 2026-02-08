-- Schema placeholder. Paste your schema here.
/* ============================================================================
   MOVIE STREAMING SYSTEM DATABASE SCHEMA
   Style: Rophim
   DB: PostgreSQL
   Purpose:
   - Crawl nhiều nguồn (ophim, kkphim...)
   - Chuẩn hoá dữ liệu phim (canonical)
   - Lưu tập / server / stream
   - Hỗ trợ search, filter, ranking
   - Tracking crawl + audit thay đổi
============================================================================ */


/* ============================================================================
   1. EXTENSIONS
   - unaccent : bỏ dấu tiếng Việt cho search
   - pg_trgm  : fuzzy / autocomplete search
============================================================================ */
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_trgm;


/* ============================================================================
   2. ENUM / TYPE DEFINITIONS
============================================================================ */

-- loại phim
CREATE TYPE movie_type AS ENUM ('single', 'series');

-- trạng thái phim
CREATE TYPE movie_status AS ENUM ('ongoing', 'completed', 'upcoming', 'unknown');

-- trạng thái crawl
CREATE TYPE crawl_status AS ENUM ('ok', 'error', 'removed', 'blocked', 'unknown');

-- loại video server / link
CREATE TYPE video_kind AS ENUM ('embed', 'hls', 'mp4', 'external');

-- vai trò người tham gia phim
CREATE TYPE people_role AS ENUM ('actor', 'director', 'writer', 'producer', 'other');

-- log level
CREATE TYPE log_level AS ENUM ('info', 'warn', 'error');

-- audit change type
CREATE TYPE change_type AS ENUM ('insert', 'update', 'delete');

-- cách match phim giữa các nguồn
CREATE TYPE match_method AS ENUM ('manual', 'imdb', 'tmdb', 'title_year', 'other');


/* ============================================================================
   3. CANONICAL MOVIES TABLE
   - Bảng phim CHUẨN của hệ thống
   - App chỉ nên đọc từ đây
============================================================================ */

CREATE TABLE movies (
  id BIGSERIAL PRIMARY KEY,

  -- slug nội bộ (unique)
  slug VARCHAR(255) NOT NULL UNIQUE,

  -- tiêu đề
  title VARCHAR(500) NOT NULL,
  original_title VARCHAR(500),

  -- alias / tên khác (json array)
  other_titles JSONB NOT NULL DEFAULT '[]',

  -- loại phim: single / series
  type movie_type NOT NULL DEFAULT 'single',

  year INT,
  release_date DATE,
  duration_min INT,

  status movie_status NOT NULL DEFAULT 'unknown',
  content_rating VARCHAR(50),   -- 13+, 18+...
  quality VARCHAR(50),          -- HD/FHD/4K
  language VARCHAR(50),
  subtitle VARCHAR(50),         -- vietsub/thuyetminh/raw

  plot TEXT,
  poster_url TEXT,
  backdrop_url TEXT,
  trailer_url TEXT,

  imdb_id VARCHAR(20),
  tmdb_id INT,

  -- dùng cho ranking
  popularity_score DOUBLE PRECISION NOT NULL DEFAULT 0,
  view_count BIGINT NOT NULL DEFAULT 0,
  rating_avg NUMERIC(3,2) NOT NULL DEFAULT 0,
  rating_count INT NOT NULL DEFAULT 0,

  -- soft delete / hide
  is_active BOOLEAN NOT NULL DEFAULT TRUE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- index phục vụ browse & search
CREATE INDEX idx_movies_type_year ON movies(type, year);
CREATE INDEX idx_movies_popularity ON movies(popularity_score DESC);
CREATE INDEX idx_movies_view ON movies(view_count DESC);
CREATE INDEX idx_movies_imdb ON movies(imdb_id);
CREATE INDEX idx_movies_tmdb ON movies(tmdb_id);


/* ============================================================================
   4. TAXONOMY TABLES
   - genres, countries, tags
============================================================================ */

CREATE TABLE genres (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(255) NOT NULL UNIQUE
);

CREATE TABLE countries (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  code VARCHAR(16) UNIQUE
);

CREATE TABLE tags (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(255) NOT NULL UNIQUE
);

-- many-to-many mappings
CREATE TABLE movie_genres (
  movie_id BIGINT REFERENCES movies(id) ON DELETE CASCADE,
  genre_id BIGINT REFERENCES genres(id) ON DELETE RESTRICT,
  PRIMARY KEY (movie_id, genre_id)
);

CREATE TABLE movie_countries (
  movie_id BIGINT REFERENCES movies(id) ON DELETE CASCADE,
  country_id BIGINT REFERENCES countries(id) ON DELETE RESTRICT,
  PRIMARY KEY (movie_id, country_id)
);

CREATE TABLE movie_tags (
  movie_id BIGINT REFERENCES movies(id) ON DELETE CASCADE,
  tag_id BIGINT REFERENCES tags(id) ON DELETE RESTRICT,
  PRIMARY KEY (movie_id, tag_id)
);


/* ============================================================================
   5. PEOPLE (CAST / CREW)
============================================================================ */

CREATE TABLE people (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(255) NOT NULL UNIQUE,
  avatar_url TEXT,
  bio TEXT,
  birth_date DATE,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE movie_people (
  id BIGSERIAL PRIMARY KEY,
  movie_id BIGINT REFERENCES movies(id) ON DELETE CASCADE,
  person_id BIGINT REFERENCES people(id) ON DELETE RESTRICT,
  role_type people_role NOT NULL,
  character_name VARCHAR(255),
  order_index INT,
  UNIQUE(movie_id, person_id, role_type, character_name)
);


/* ============================================================================
   6. SEASON / EPISODE / VIDEO
============================================================================ */

CREATE TABLE seasons (
  id BIGSERIAL PRIMARY KEY,
  movie_id BIGINT REFERENCES movies(id) ON DELETE CASCADE,
  season_number INT NOT NULL,
  title VARCHAR(255),
  UNIQUE(movie_id, season_number)
);

CREATE TABLE episodes (
  id BIGSERIAL PRIMARY KEY,
  movie_id BIGINT REFERENCES movies(id) ON DELETE CASCADE,
  season_id BIGINT REFERENCES seasons(id) ON DELETE SET NULL,
  episode_number INT,
  name VARCHAR(255),
  air_date DATE,
  duration_min INT,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(movie_id, season_id, episode_number)
);

CREATE TABLE video_servers (
  id BIGSERIAL PRIMARY KEY,
  episode_id BIGINT REFERENCES episodes(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  kind video_kind NOT NULL DEFAULT 'hls',
  priority INT DEFAULT 0,
  is_active BOOLEAN DEFAULT TRUE,
  UNIQUE(episode_id, name)
);

CREATE TABLE video_streams (
  id BIGSERIAL PRIMARY KEY,
  server_id BIGINT REFERENCES video_servers(id) ON DELETE CASCADE,
  label VARCHAR(50),        -- 1080p, 720p
  url TEXT NOT NULL,
  headers JSONB,
  drm JSONB,
  priority INT DEFAULT 0,
  is_active BOOLEAN DEFAULT TRUE,
  checksum VARCHAR(64),     -- hash(url) để dedup
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_video_streams_checksum ON video_streams(checksum);


/* ============================================================================
   7. SOURCE LAYER (CRAWL)
============================================================================ */

CREATE TABLE sources (
  id BIGSERIAL PRIMARY KEY,
  code VARCHAR(50) NOT NULL UNIQUE, -- ophim, kkphim
  base_url TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE source_items (
  id BIGSERIAL PRIMARY KEY,
  source_id BIGINT REFERENCES sources(id) ON DELETE CASCADE,
  external_id VARCHAR(255) NOT NULL,
  external_url TEXT,
  type movie_type,
  title VARCHAR(500),
  year INT,
  payload JSONB NOT NULL DEFAULT '{}',
  content_hash VARCHAR(64),
  last_crawled_at TIMESTAMPTZ,
  crawl_status crawl_status DEFAULT 'unknown',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(source_id, external_id)
);

CREATE TABLE movie_source_map (
  id BIGSERIAL PRIMARY KEY,
  movie_id BIGINT REFERENCES movies(id) ON DELETE CASCADE,
  source_item_id BIGINT REFERENCES source_items(id) ON DELETE CASCADE,
  confidence NUMERIC(4,3) DEFAULT 1.0,
  is_primary BOOLEAN DEFAULT FALSE,
  matched_by match_method DEFAULT 'other',
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(source_item_id)
);


/* ============================================================================
   8. CRAWL JOB / LOG / AUDIT
============================================================================ */

CREATE TABLE crawl_jobs (
  id BIGSERIAL PRIMARY KEY,
  source_id BIGINT REFERENCES sources(id),
  job_type VARCHAR(50),
  status VARCHAR(30) DEFAULT 'running',
  started_at TIMESTAMPTZ DEFAULT now(),
  finished_at TIMESTAMPTZ,
  stats JSONB DEFAULT '{}'
);

CREATE TABLE crawl_logs (
  id BIGSERIAL PRIMARY KEY,
  job_id BIGINT REFERENCES crawl_jobs(id) ON DELETE CASCADE,
  source_item_id BIGINT REFERENCES source_items(id) ON DELETE SET NULL,
  level log_level DEFAULT 'info',
  message TEXT NOT NULL,
  meta JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE entity_change_logs (
  id BIGSERIAL PRIMARY KEY,
  entity_type VARCHAR(30),   -- movie / episode / stream
  entity_id BIGINT,
  change_type change_type,
  before JSONB,
  after JSONB,
  source_id BIGINT REFERENCES sources(id),
  created_at TIMESTAMPTZ DEFAULT now()
);


/* ============================================================================
   9. SEARCH DENORMALIZED TABLE
   - Dùng cho PostgreSQL Full-Text + Autocomplete
============================================================================ */

CREATE TABLE movie_search_docs (
  movie_id BIGINT PRIMARY KEY REFERENCES movies(id) ON DELETE CASCADE,

  title TEXT,
  original_title TEXT,
  aliases_text TEXT,
  genres_text TEXT,
  countries_text TEXT,
  tags_text TEXT,
  people_text TEXT,
  plot TEXT,

  -- text gộp cho trigram
  search_text TEXT,

  -- full-text search vector
  tsv TSVECTOR,

  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_movie_search_docs_tsv
  ON movie_search_docs USING GIN(tsv);

CREATE INDEX idx_movie_search_docs_trgm
  ON movie_search_docs USING GIN(search_text gin_trgm_ops);

/* ============================================================================
   10. COLLECTIONS
   - Bộ sưu tập cho trang chủ / danh mục
============================================================================ */

CREATE TABLE collections (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(255) NOT NULL UNIQUE,
  "order" INT NOT NULL DEFAULT 0,
  random_data BOOLEAN NOT NULL DEFAULT TRUE,
  type INT,
  filter JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_published BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_collections_published ON collections(is_published);
CREATE INDEX idx_collections_order ON collections("order");


/* ============================================================================
   END OF SCHEMA
============================================================================ */
