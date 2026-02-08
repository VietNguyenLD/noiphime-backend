import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';

type CollectionRow = {
  id: string;
  name: string;
  slug: string;
  order: number;
  random_data: boolean | null;
  type: number | null;
  filter: Record<string, any> | null;
};

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
  imdb_rating: string | number | null;
  latest_episode: number | null;
  year: number | null;
  genres: any[] | null;
  images: Record<string, any> | null;
};

@Injectable()
export class CollectionsService {
  constructor(private readonly db: DatabaseService) {}

  async getCollectionList(page = 1, limit = 10) {
    const safePage = Math.max(1, Number(page) || 1);
    const safeLimit = Math.min(Math.max(1, Number(limit) || 10), 50);
    const offset = (safePage - 1) * safeLimit;

    try {
      const totalRows = await this.db.query<{ total: string }>(
        `SELECT COUNT(*)::text AS total FROM collections WHERE is_published = true`,
      );
      const total = parseInt(totalRows[0]?.total || '0', 10);
      const totalPages = Math.ceil(total / safeLimit);

      const collections = await this.db.query<CollectionRow>(
        `
        SELECT
          id,
          name,
          slug,
          "order",
          random_data,
          type,
          filter
        FROM collections
        WHERE is_published = true
        ORDER BY "order" ASC
        LIMIT $1 OFFSET $2
        `,
        [safeLimit, offset],
      );

      const collectionsWithMovies = await Promise.all(
        collections.map(async (collection) => {
          const movies = await this.fetchMoviesForCollection(collection);
          return {
            _id: collection.id,
            name: collection.name,
            slug: collection.slug,
            order: collection.order,
            random_data: collection.random_data ?? true,
            type: collection.type,
            filter: collection.filter || {},
            movies,
          };
        }),
      );

      return { collections: collectionsWithMovies, totalPages };
    } catch (error: any) {
      throw new HttpException(
        error?.message || 'Database error',
        error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  private async fetchMoviesForCollection(collection: CollectionRow): Promise<MovieRow[]> {
    const filter = collection.filter || {};
    const where: string[] = ['m.is_active = true'];
    const params: any[] = [];

    const countryCodes = Array.isArray(filter.country_code)
      ? filter.country_code.filter((code: any) => !!code).map((code: any) => String(code))
      : [];
    if (countryCodes.length > 0) {
      params.push(countryCodes);
      where.push(
        `EXISTS (
          SELECT 1
          FROM movie_countries mc
          JOIN countries c ON c.id = mc.country_id
          WHERE mc.movie_id = m.id AND c.code = ANY($${params.length})
        )`,
      );
    }

    const genreSlug = filter.genre_slug ? String(filter.genre_slug).trim() : '';
    if (genreSlug) {
      params.push(genreSlug);
      where.push(
        `EXISTS (
          SELECT 1
          FROM movie_genres mg
          JOIN genres g ON g.id = mg.genre_id
          WHERE mg.movie_id = m.id AND g.slug = $${params.length}
        )`,
      );
    }

    const status = this.normalizeStatus(filter.status);
    if (status) {
      params.push(status);
      where.push(`m.status = $${params.length}`);
    }

    const resolvedType = this.resolveMovieType(collection.type, filter.type);
    if (resolvedType) {
      params.push(resolvedType);
      where.push(`m.type = $${params.length}`);
    }

    const movieLimit = this.parseLimit(filter.limit, 20, 1, 200);

    const sortClause = this.buildSortClause(filter, collection.random_data ?? true);

    params.push(movieLimit);
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
        NULL::numeric AS imdb_rating,
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
      ${sortClause}
      LIMIT $${params.length};
    `;

    return this.db.query<MovieRow>(sql, params);
  }

  private resolveMovieType(collectionType: number | null, filterType: any): 'single' | 'series' | null {
    if (collectionType === 1) return 'single';
    if (collectionType === 2) return 'series';
    const raw = String(filterType || '').toLowerCase().trim();
    if (!raw) return null;
    if (['movie', 'single', 'phimle', 'phim-le'].includes(raw)) return 'single';
    if (['tv', 'series', 'phimbo', 'phim-bo', 'hoathinh'].includes(raw)) return 'series';
    return null;
  }

  private normalizeStatus(status: any): string | null {
    if (!status) return null;
    const raw = String(status).trim().toLowerCase();
    if (raw === 'on going' || raw === 'ongoing') return 'ongoing';
    if (raw === 'completed' || raw === 'complete' || raw === 'full') return 'completed';
    if (raw === 'upcoming') return 'upcoming';
    return String(status);
  }

  private parseLimit(value: any, fallback: number, min: number, max: number) {
    const parsed = parseInt(String(value || ''), 10);
    if (Number.isFinite(parsed)) {
      return Math.min(Math.max(parsed, min), max);
    }
    return fallback;
  }

  private buildSortClause(filter: Record<string, any>, randomData: boolean): string {
    if (randomData) return 'ORDER BY RANDOM()';

    const topViews = String(filter.top_views || '').trim();
    if (topViews) {
      return 'ORDER BY m.view_count DESC';
    }

    const orderValue = parseInt(String(filter.order || '-1'), 10);
    const direction = orderValue === 1 ? 'ASC' : 'DESC';
    const sortByRaw = String(filter.sort_by || 'updated_at').trim().toLowerCase();
    const sortByMap: Record<string, string> = {
      updated_at: 'm.updated_at',
      year: 'm.year',
    };
    const sortColumn = sortByMap[sortByRaw] || 'm.updated_at';
    return `ORDER BY ${sortColumn} ${direction}`;
  }
}
