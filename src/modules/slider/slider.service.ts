import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { SliderQueryDto } from './dto/slider.query.dto';

type MovieRow = {
  _id: string | number;
  public_id: string | null;
  original_title: string | null;
  english_title: string | null;
  title: string | null;
  slug: string | null;
  overview: string | null;
  quality: string | null;
  rating: string | number | null;
  runtime: number | null;
  type: string | null;
  origin_country: string[] | null;
  status: string | null;
  latest_season: number | null;
  imdb_rating: string | null;
  latest_episode: number | null;
  year: number | null;
  genres: Array<{ id: number; name: string; slug: string }> | null;
  images: Record<string, any> | null;
};

@Injectable()
export class SliderService {
  constructor(private readonly db: DatabaseService) {}

  async getHomeSlider(query: SliderQueryDto) {
    const limit = Math.min(Math.max(Number(query.limit) || 4, 1), 10);
    const params: any[] = [limit];
    const where: string[] = ['m.is_active = true', 'm.rating_avg IS NOT NULL', 'm.rating_avg > 0'];

    if (query.type) {
      params.push(query.type);
      where.push(`m.type = $${params.length}`);
    } else {
      params.push('series');
      where.push(`m.type = $${params.length}`);
    }

    if (query.status) {
      params.push(query.status);
      where.push(`m.status = $${params.length}`);
    }

    try {
      const sql = `
        SELECT
          m.id AS _id,
          m.slug AS public_id,
          m.original_title AS original_title,
          m.original_title AS english_title,
          m.title AS title,
          m.slug AS slug,
          m.plot AS overview,
          m.quality AS quality,
          m.rating_avg AS rating,
          m.duration_min AS runtime,
          m.type AS type,
          COALESCE(origin.origin_country, ARRAY[]::text[]) AS origin_country,
          m.status AS status,
          season.latest_season AS latest_season,
          m.rating_avg::text AS imdb_rating,
          ep.latest_episode AS latest_episode,
          m.year AS year,
          COALESCE(genres.genres, '[]'::json) AS genres,
          jsonb_build_object('poster', m.poster_url, 'backdrop', m.backdrop_url) AS images
        FROM movies m
        LEFT JOIN LATERAL (
          SELECT ARRAY_REMOVE(ARRAY_AGG(DISTINCT c.code), NULL) AS origin_country
          FROM movie_countries mc
          JOIN countries c ON c.id = mc.country_id
          WHERE mc.movie_id = m.id
        ) origin ON true
        LEFT JOIN LATERAL (
          SELECT json_agg(json_build_object('id', g.id, 'name', g.name, 'slug', g.slug) ORDER BY g.name) AS genres
          FROM movie_genres mg
          JOIN genres g ON g.id = mg.genre_id
          WHERE mg.movie_id = m.id
        ) genres ON true
        LEFT JOIN LATERAL (
          SELECT MAX(season_number) AS latest_season
          FROM seasons
          WHERE movie_id = m.id
        ) season ON true
        LEFT JOIN LATERAL (
          SELECT MAX(episode_number) AS latest_episode
          FROM episodes
          WHERE movie_id = m.id
        ) ep ON true
        WHERE ${where.join(' AND ')}
        ORDER BY m.rating_avg DESC, m.updated_at DESC
        LIMIT $1;
      `;

      const movies = await this.db.query<MovieRow>(sql, params);
      const items = movies.map((movie, index) => ({
        order: index + 1,
        headline: movie.title || `Top IMDb #${index + 1}`,
        subhead: this.buildSubhead(movie),
        cta_text: 'Xem ngay',
        movie,
      }));

      return { items };
    } catch (error: any) {
      throw new HttpException(
        error?.message || 'Database error',
        error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  private buildSubhead(movie: MovieRow) {
    const genreNames =
      movie.genres && Array.isArray(movie.genres)
        ? movie.genres.map((g) => g.name).filter(Boolean)
        : [];
    const genresText = genreNames.slice(0, 2).join(', ');
    const yearText = movie.year ? String(movie.year) : '';
    const countryText = movie.origin_country && movie.origin_country[0] ? movie.origin_country[0] : '';

    return [genresText, yearText, countryText].filter(Boolean).join(' · ');
  }
}
