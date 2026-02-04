/* ============================================================================
   10. SEARCH: QUEUE + FUNCTIONS + TRIGGERS
   - Mục tiêu: cập nhật movie_search_docs mỗi khi movie / taxonomy / people thay đổi
   - Tránh làm nặng trong trigger: dùng queue để rebuild async (cron/worker).
============================================================================ */


/* ============================================================================
   10.1. QUEUE TABLE
   - Trigger chỉ đẩy movie_id vào queue.
   - Worker gọi process_movie_search_queue() để rebuild theo batch.
============================================================================ */

CREATE TABLE IF NOT EXISTS movie_search_queue (
  movie_id    BIGINT PRIMARY KEY REFERENCES movies(id) ON DELETE CASCADE,
  reason      TEXT,
  enqueued_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_movie_search_queue_time
  ON movie_search_queue(enqueued_at);


/* ============================================================================
   10.2. HELPER FUNCTION: normalize_text
   - Chuẩn hoá text để search: lower + unaccent
   - Lưu ý: unaccent extension đã bật ở phần schema trước.
============================================================================ */

CREATE OR REPLACE FUNCTION normalize_text(input TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT lower(unaccent(coalesce(input, '')));
$$;


/* ============================================================================
   10.3. ENQUEUE FUNCTION
   - Dùng trong trigger để đánh dấu movie cần rebuild search doc.
   - ON CONFLICT: nếu đã có trong queue thì update reason + time
============================================================================ */

CREATE OR REPLACE FUNCTION enqueue_movie_search(p_movie_id BIGINT, p_reason TEXT DEFAULT NULL)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_movie_id IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO movie_search_queue(movie_id, reason, enqueued_at)
  VALUES (p_movie_id, p_reason, now())
  ON CONFLICT (movie_id)
  DO UPDATE SET
    reason = COALESCE(EXCLUDED.reason, movie_search_queue.reason),
    enqueued_at = now();
END;
$$;


/* ============================================================================
   10.4. REBUILD FUNCTION: rebuild_movie_search_doc(movie_id)
   - Tạo 1 dòng trong movie_search_docs (upsert)
   - Dữ liệu gộp từ:
     + movies (title/original/aliases/plot)
     + genres/countries/tags
     + people (cast/crew)
   - tsv dùng cấu hình 'simple' + unaccent để phù hợp tiếng Việt hơn.
   - Weight:
     A: title
     B: original_title + aliases
     C: genres/tags/people/countries
     D: plot
============================================================================ */

CREATE OR REPLACE FUNCTION rebuild_movie_search_doc(p_movie_id BIGINT)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  v_title          TEXT;
  v_original       TEXT;
  v_aliases        TEXT;
  v_plot           TEXT;

  v_genres         TEXT;
  v_countries      TEXT;
  v_tags           TEXT;
  v_people         TEXT;

  v_search_text    TEXT;
  v_tsv            TSVECTOR;
BEGIN
  -- Lấy dữ liệu movie cơ bản
  SELECT
    m.title,
    m.original_title,
    -- other_titles là JSON array: ["Tên khác 1", "Tên khác 2", ...]
    (
      SELECT string_agg(value::text, ' ')
      FROM jsonb_array_elements_text(m.other_titles) AS value
    ) AS aliases_text,
    m.plot
  INTO v_title, v_original, v_aliases, v_plot
  FROM movies m
  WHERE m.id = p_movie_id;

  IF v_title IS NULL THEN
    -- movie không tồn tại hoặc bị xoá
    DELETE FROM movie_search_docs WHERE movie_id = p_movie_id;
    RETURN;
  END IF;

  -- Genres
  SELECT COALESCE(string_agg(g.name, ' '), '')
  INTO v_genres
  FROM movie_genres mg
  JOIN genres g ON g.id = mg.genre_id
  WHERE mg.movie_id = p_movie_id;

  -- Countries
  SELECT COALESCE(string_agg(c.name, ' '), '')
  INTO v_countries
  FROM movie_countries mc
  JOIN countries c ON c.id = mc.country_id
  WHERE mc.movie_id = p_movie_id;

  -- Tags
  SELECT COALESCE(string_agg(t.name, ' '), '')
  INTO v_tags
  FROM movie_tags mt
  JOIN tags t ON t.id = mt.tag_id
  WHERE mt.movie_id = p_movie_id;

  -- People: gộp cả tên cast/crew + character (nếu có)
  SELECT COALESCE(string_agg(
           p.name || CASE WHEN mp.character_name IS NOT NULL THEN (' ' || mp.character_name) ELSE '' END
         , ' '), '')
  INTO v_people
  FROM movie_people mp
  JOIN people p ON p.id = mp.person_id
  WHERE mp.movie_id = p_movie_id;

  -- search_text: phục vụ trigram/autocomplete, nên gộp tất cả field quan trọng
  v_search_text :=
    normalize_text(
      coalesce(v_title,'') || ' ' ||
      coalesce(v_original,'') || ' ' ||
      coalesce(v_aliases,'') || ' ' ||
      coalesce(v_genres,'') || ' ' ||
      coalesce(v_countries,'') || ' ' ||
      coalesce(v_tags,'') || ' ' ||
      coalesce(v_people,'')
    );

  -- TSVECTOR: full-text
  v_tsv :=
      setweight(to_tsvector('simple', normalize_text(v_title)), 'A')
    || setweight(to_tsvector('simple', normalize_text(coalesce(v_original,''))), 'B')
    || setweight(to_tsvector('simple', normalize_text(coalesce(v_aliases,''))), 'B')
    || setweight(to_tsvector('simple', normalize_text(coalesce(v_genres,''))), 'C')
    || setweight(to_tsvector('simple', normalize_text(coalesce(v_tags,''))), 'C')
    || setweight(to_tsvector('simple', normalize_text(coalesce(v_countries,''))), 'C')
    || setweight(to_tsvector('simple', normalize_text(coalesce(v_people,''))), 'C')
    || setweight(to_tsvector('simple', normalize_text(coalesce(v_plot,''))), 'D');

  -- Upsert movie_search_docs
  INSERT INTO movie_search_docs(
    movie_id,
    title, original_title, aliases_text,
    genres_text, countries_text, tags_text, people_text,
    plot,
    search_text,
    tsv,
    updated_at
  )
  VALUES (
    p_movie_id,
    v_title, v_original, v_aliases,
    v_genres, v_countries, v_tags, v_people,
    v_plot,
    v_search_text,
    v_tsv,
    now()
  )
  ON CONFLICT (movie_id) DO UPDATE SET
    title          = EXCLUDED.title,
    original_title = EXCLUDED.original_title,
    aliases_text   = EXCLUDED.aliases_text,
    genres_text    = EXCLUDED.genres_text,
    countries_text = EXCLUDED.countries_text,
    tags_text      = EXCLUDED.tags_text,
    people_text    = EXCLUDED.people_text,
    plot           = EXCLUDED.plot,
    search_text    = EXCLUDED.search_text,
    tsv            = EXCLUDED.tsv,
    updated_at     = now();
END;
$$;


/* ============================================================================
   10.5. PROCESS QUEUE FUNCTION
   - Worker/cron gọi function này theo batch.
   - limit mặc định 500 (tuỳ bạn chỉnh).
   - Cách chạy ví dụ:
       SELECT process_movie_search_queue(500);
============================================================================ */

CREATE OR REPLACE FUNCTION process_movie_search_queue(p_limit INT DEFAULT 500)
RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
  r RECORD;
  v_count INT := 0;
BEGIN
  FOR r IN
    SELECT movie_id
    FROM movie_search_queue
    ORDER BY enqueued_at
    LIMIT p_limit
  LOOP
    PERFORM rebuild_movie_search_doc(r.movie_id);
    DELETE FROM movie_search_queue WHERE movie_id = r.movie_id;
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;


/* ============================================================================
   10.6. TRIGGERS: ENQUEUE WHEN DATA CHANGES
============================================================================ */

-- 10.6.1 movies: khi insert/update title/original/plot/other_titles...
CREATE OR REPLACE FUNCTION trg_movies_enqueue_search()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Chỉ enqueue khi những field liên quan search thay đổi.
  -- (Bạn có thể nới lỏng: cứ UPDATE là enqueue cũng được.)
  IF TG_OP = 'INSERT' THEN
    PERFORM enqueue_movie_search(NEW.id, 'movies.insert');
  ELSIF TG_OP = 'UPDATE' THEN
    IF (NEW.title IS DISTINCT FROM OLD.title)
    OR (NEW.original_title IS DISTINCT FROM OLD.original_title)
    OR (NEW.other_titles IS DISTINCT FROM OLD.other_titles)
    OR (NEW.plot IS DISTINCT FROM OLD.plot)
    OR (NEW.is_active IS DISTINCT FROM OLD.is_active)
    THEN
      PERFORM enqueue_movie_search(NEW.id, 'movies.update');
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS movies_enqueue_search ON movies;
CREATE TRIGGER movies_enqueue_search
AFTER INSERT OR UPDATE ON movies
FOR EACH ROW
EXECUTE FUNCTION trg_movies_enqueue_search();


-- 10.6.2 movie_genres / movie_tags / movie_countries: thay đổi taxonomy mapping -> enqueue movie
CREATE OR REPLACE FUNCTION trg_movie_map_enqueue_search()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_movie_id BIGINT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_movie_id := OLD.movie_id;
  ELSE
    v_movie_id := NEW.movie_id;
  END IF;

  PERFORM enqueue_movie_search(v_movie_id, TG_TABLE_NAME || '.' || lower(TG_OP));
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS movie_genres_enqueue_search ON movie_genres;
CREATE TRIGGER movie_genres_enqueue_search
AFTER INSERT OR UPDATE OR DELETE ON movie_genres
FOR EACH ROW
EXECUTE FUNCTION trg_movie_map_enqueue_search();

DROP TRIGGER IF EXISTS movie_tags_enqueue_search ON movie_tags;
CREATE TRIGGER movie_tags_enqueue_search
AFTER INSERT OR UPDATE OR DELETE ON movie_tags
FOR EACH ROW
EXECUTE FUNCTION trg_movie_map_enqueue_search();

DROP TRIGGER IF EXISTS movie_countries_enqueue_search ON movie_countries;
CREATE TRIGGER movie_countries_enqueue_search
AFTER INSERT OR UPDATE OR DELETE ON movie_countries
FOR EACH ROW
EXECUTE FUNCTION trg_movie_map_enqueue_search();


-- 10.6.3 movie_people: thay đổi cast/crew -> enqueue movie
DROP TRIGGER IF EXISTS movie_people_enqueue_search ON movie_people;
CREATE TRIGGER movie_people_enqueue_search
AFTER INSERT OR UPDATE OR DELETE ON movie_people
FOR EACH ROW
EXECUTE FUNCTION trg_movie_map_enqueue_search();


/* ============================================================================
   10.7. TRIGGERS: WHEN LOOKUP TABLE NAMES CHANGE
   - Nếu đổi tên genre/tag/country/people -> cần enqueue tất cả movie liên quan.
   - Vì update 1 genre có thể ảnh hưởng hàng ngàn movie, trigger sẽ enqueue theo batch INSERT..SELECT.
============================================================================ */

-- genres name/slug change
CREATE OR REPLACE FUNCTION trg_genres_enqueue_movies()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.name IS DISTINCT FROM OLD.name) OR (NEW.slug IS DISTINCT FROM OLD.slug) THEN
    INSERT INTO movie_search_queue(movie_id, reason, enqueued_at)
    SELECT mg.movie_id, 'genres.update', now()
    FROM movie_genres mg
    WHERE mg.genre_id = NEW.id
    ON CONFLICT (movie_id) DO UPDATE SET enqueued_at = now(), reason = 'genres.update';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS genres_enqueue_movies ON genres;
CREATE TRIGGER genres_enqueue_movies
AFTER UPDATE ON genres
FOR EACH ROW
EXECUTE FUNCTION trg_genres_enqueue_movies();


-- tags name/slug change
CREATE OR REPLACE FUNCTION trg_tags_enqueue_movies()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.name IS DISTINCT FROM OLD.name) OR (NEW.slug IS DISTINCT FROM OLD.slug) THEN
    INSERT INTO movie_search_queue(movie_id, reason, enqueued_at)
    SELECT mt.movie_id, 'tags.update', now()
    FROM movie_tags mt
    WHERE mt.tag_id = NEW.id
    ON CONFLICT (movie_id) DO UPDATE SET enqueued_at = now(), reason = 'tags.update';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tags_enqueue_movies ON tags;
CREATE TRIGGER tags_enqueue_movies
AFTER UPDATE ON tags
FOR EACH ROW
EXECUTE FUNCTION trg_tags_enqueue_movies();


-- countries name/code change
CREATE OR REPLACE FUNCTION trg_countries_enqueue_movies()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.name IS DISTINCT FROM OLD.name) OR (NEW.code IS DISTINCT FROM OLD.code) THEN
    INSERT INTO movie_search_queue(movie_id, reason, enqueued_at)
    SELECT mc.movie_id, 'countries.update', now()
    FROM movie_countries mc
    WHERE mc.country_id = NEW.id
    ON CONFLICT (movie_id) DO UPDATE SET enqueued_at = now(), reason = 'countries.update';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS countries_enqueue_movies ON countries;
CREATE TRIGGER countries_enqueue_movies
AFTER UPDATE ON countries
FOR EACH ROW
EXECUTE FUNCTION trg_countries_enqueue_movies();


-- people name change: enqueue tất cả movie có person đó
CREATE OR REPLACE FUNCTION trg_people_enqueue_movies()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.name IS DISTINCT FROM OLD.name) OR (NEW.slug IS DISTINCT FROM OLD.slug) THEN
    INSERT INTO movie_search_queue(movie_id, reason, enqueued_at)
    SELECT mp.movie_id, 'people.update', now()
    FROM movie_people mp
    WHERE mp.person_id = NEW.id
    ON CONFLICT (movie_id) DO UPDATE SET enqueued_at = now(), reason = 'people.update';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS people_enqueue_movies ON people;
CREATE TRIGGER people_enqueue_movies
AFTER UPDATE ON people
FOR EACH ROW
EXECUTE FUNCTION trg_people_enqueue_movies();


/* ============================================================================
   10.8. OPTIONAL: ONE-TIME BACKFILL / REBUILD ALL
   - Dùng khi mới deploy hoặc thay đổi logic search.
   - Chạy:
       INSERT INTO movie_search_queue(movie_id, reason)
       SELECT id, 'backfill' FROM movies WHERE is_active = true
       ON CONFLICT (movie_id) DO UPDATE SET enqueued_at = now(), reason = 'backfill';
       SELECT process_movie_search_queue(500);
       -- lặp cho đến khi queue rỗng
============================================================================ */
