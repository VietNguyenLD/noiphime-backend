-- Seed sample slider data

-- Create slider "home" if not exists
INSERT INTO sliders (code, name, description, is_active)
VALUES ('home', 'Home Slider', 'Sample slider for homepage', true)
ON CONFLICT (code) DO NOTHING;

-- Insert a few items using existing movies (most recent)
WITH slider AS (
  SELECT id FROM sliders WHERE code = 'home' LIMIT 1
), picks AS (
  SELECT id, poster_url, backdrop_url
  FROM movies
  WHERE is_active = true
  ORDER BY rating_avg DESC NULLS LAST, updated_at DESC
  LIMIT 3
)
INSERT INTO slider_items (slider_id, movie_id, order_index, headline, subhead, cta_text, image_url, is_active)
SELECT
  slider.id,
  picks.id,
  ROW_NUMBER() OVER (ORDER BY picks.id),
  'Top Pick',
  NULL,
  'Xem ngay',
  COALESCE(picks.backdrop_url, picks.poster_url),
  true
FROM slider, picks
ON CONFLICT (slider_id, movie_id) DO NOTHING;
