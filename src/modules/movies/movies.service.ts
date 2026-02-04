import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { MoviesListQueryDto } from './dto/movies-list.dto';

@Injectable()
export class MoviesService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async listMovies(query: MoviesListQueryDto) {
    const page = query.page || 1;
    const limit = Math.min(query.limit || 20, 50);
    const offset = (page - 1) * limit;

    const params: unknown[] = [];
    const where: string[] = ['m.is_active = true'];
    const joins: string[] = [];

    if (query.type) {
      params.push(query.type);
      where.push(`m.type = $${params.length}`);
    }

    if (query.year) {
      params.push(query.year);
      where.push(`m.year = $${params.length}`);
    }

    if (query.status) {
      params.push(query.status);
      where.push(`m.status = $${params.length}`);
    }

    if (query.genre) {
      joins.push('JOIN movie_genres mg ON mg.movie_id = m.id');
      joins.push('JOIN genres g ON g.id = mg.genre_id');
      params.push(query.genre);
      where.push(`g.slug = $${params.length}`);
    }

    if (query.country) {
      joins.push('JOIN movie_countries mc ON mc.movie_id = m.id');
      joins.push('JOIN countries c ON c.id = mc.country_id');
      params.push(query.country);
      where.push(`(c.code = $${params.length} OR c.name = $${params.length})`);
    }

    if (query.q) {
      const q = query.q;
      const sql = `
        SELECT m.*
        FROM movie_search_docs msd
        JOIN movies m ON m.id = msd.movie_id
        ${joins.length ? joins.join('\n') : ''}
        WHERE ${where.join(' AND ')}
          AND (
            msd.tsv @@ plainto_tsquery('simple', unaccent($1))
            OR msd.search_text % unaccent($1)
          )
        ORDER BY
          ts_rank_cd(msd.tsv, plainto_tsquery('simple', unaccent($1))) DESC,
          m.popularity_score DESC
        LIMIT $2 OFFSET $3;
      `;
      const items = await this.dataSource.query(sql, [q, limit, offset]);
      const total = await this.countMoviesWithSearch(q, joins, where);
      return this.paginated(items, total, page, limit);
    }

    let orderBy = 'm.popularity_score DESC';
    if (query.sort === 'new') {
      orderBy = 'm.year DESC NULLS LAST, m.created_at DESC';
    } else if (query.sort === 'updated') {
      orderBy = 'm.updated_at DESC';
    }

    params.push(limit, offset);
    const sql = `
      SELECT m.*
      FROM movies m
      ${joins.length ? joins.join('\n') : ''}
      WHERE ${where.join(' AND ')}
      ORDER BY ${orderBy}
      LIMIT $${params.length - 1} OFFSET $${params.length};
    `;
    const items = await this.dataSource.query(sql, params);
    const total = await this.countMovies(joins, where, params.slice(0, -2));
    return this.paginated(items, total, page, limit);
  }

  private async countMovies(joins: string[], where: string[], params: unknown[]) {
    const sql = `
      SELECT COUNT(DISTINCT m.id) AS total
      FROM movies m
      ${joins.length ? joins.join('\n') : ''}
      WHERE ${where.join(' AND ')};
    `;
    const rows = await this.dataSource.query(sql, params);
    return parseInt(rows[0]?.total || '0', 10);
  }

  private async countMoviesWithSearch(q: string, joins: string[], where: string[]) {
    const sql = `
      SELECT COUNT(DISTINCT m.id) AS total
      FROM movie_search_docs msd
      JOIN movies m ON m.id = msd.movie_id
      ${joins.length ? joins.join('\n') : ''}
      WHERE ${where.join(' AND ')}
        AND (
          msd.tsv @@ plainto_tsquery('simple', unaccent($1))
          OR msd.search_text % unaccent($1)
        );
    `;
    const rows = await this.dataSource.query(sql, [q]);
    return parseInt(rows[0]?.total || '0', 10);
  }

  private paginated(items: unknown[], total: number, page: number, limit: number) {
    const totalPages = Math.ceil(total / limit);
    return {
      data: items,
      meta: {
        page,
        limit,
        total,
        totalPages,
      },
    };
  }

  async getMovieBySlug(slug: string) {
    const movieSql = `
      SELECT *
      FROM movies
      WHERE slug = $1 AND is_active = true
      LIMIT 1;
    `;
    const movieRows = await this.dataSource.query(movieSql, [slug]);
    const movie = movieRows[0];
    if (!movie) return null;

    const [genres, countries, tags, cast] = await Promise.all([
      this.dataSource.query(
        `
        SELECT g.*
        FROM movie_genres mg
        JOIN genres g ON g.id = mg.genre_id
        WHERE mg.movie_id = $1
        ORDER BY g.name ASC;
        `,
        [movie.id],
      ),
      this.dataSource.query(
        `
        SELECT c.*
        FROM movie_countries mc
        JOIN countries c ON c.id = mc.country_id
        WHERE mc.movie_id = $1
        ORDER BY c.name ASC;
        `,
        [movie.id],
      ),
      this.dataSource.query(
        `
        SELECT t.*
        FROM movie_tags mt
        JOIN tags t ON t.id = mt.tag_id
        WHERE mt.movie_id = $1
        ORDER BY t.name ASC;
        `,
        [movie.id],
      ),
      this.dataSource.query(
        `
        SELECT p.*, mp.role_type, mp.character_name, mp.order_index
        FROM movie_people mp
        JOIN people p ON p.id = mp.person_id
        WHERE mp.movie_id = $1
        ORDER BY mp.order_index ASC;
        `,
        [movie.id],
      ),
    ]);

    return {
      ...movie,
      genres,
      countries,
      tags,
      cast,
    };
  }

  async getEpisodesBySlug(slug: string) {
    const movieRows = await this.dataSource.query(
      `
      SELECT id, type
      FROM movies
      WHERE slug = $1 AND is_active = true
      LIMIT 1;
      `,
      [slug],
    );
    const movie = movieRows[0];
    if (!movie) return null;

    const seasons = await this.dataSource.query(
      `
      SELECT *
      FROM seasons
      WHERE movie_id = $1
      ORDER BY season_number ASC;
      `,
      [movie.id],
    );

    const episodes = await this.dataSource.query(
      `
      SELECT *
      FROM episodes
      WHERE movie_id = $1 AND is_active = true
      ORDER BY season_id ASC NULLS LAST, episode_number ASC;
      `,
      [movie.id],
    );

    if (!seasons.length) {
      return {
        seasons: [
          {
            id: null,
            movie_id: movie.id,
            season_number: 1,
            name: 'Season 1',
          },
        ],
        episodes,
      };
    }

    return { seasons, episodes };
  }

  async getStreamsByEpisodeId(episodeId: string) {
    const servers = await this.dataSource.query(
      `
      SELECT *
      FROM video_servers
      WHERE is_active = true AND episode_id = $1
      ORDER BY priority DESC;
      `,
      [episodeId],
    );

    const streams = await this.dataSource.query(
      `
      SELECT vs.*
      FROM video_streams vs
      JOIN video_servers v ON v.id = vs.server_id
      WHERE vs.is_active = true
        AND v.is_active = true
        AND v.episode_id = $1
      ORDER BY vs.priority DESC;
      `,
      [episodeId],
    );

    return { servers, streams };
  }
}
