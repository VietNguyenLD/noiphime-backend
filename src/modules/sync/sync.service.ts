import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, QueryRunner } from 'typeorm';
import { PayloadAdapter } from './adapters/payload-adapter';
import { OphimPayloadAdapter } from './adapters/ophim.adapter';
import { KkphimPayloadAdapter } from './adapters/kkphim.adapter';
import {
  MovieNormalized,
  PersonItem,
  SourceItemRow,
  TaxonomyItem,
} from './dto/normalized.dto';
import { normalizeTitle, sha256, slugify } from './utils/normalize';

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);
  private readonly adapters: PayloadAdapter[] = [
    new OphimPayloadAdapter(),
    new KkphimPayloadAdapter(),
  ];

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async syncSourceItem(sourceItemId: number) {
    const sourceItem = await this.getSourceItem(sourceItemId);
    this.logger.log(`[SYNC] start sourceItem=${sourceItemId}`);
    if (!sourceItem) return null;

    const adapter = this.adapters.find((item) => item.supports(sourceItem.source_code));
    if (!adapter) {
      throw new Error(`No adapter for source_id: ${sourceItem.source_id}`);
    }

    const normalized = adapter.normalize(sourceItem.payload, sourceItem);
    this.logger.log(
      `[SYNC] normalized sourceItem=${sourceItemId} seasons=${normalized.seasons?.length ?? 0} eps=${normalized.seasons?.[0]?.episodes?.length ?? 0}`,
    );

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const { movieId, matchedBy } = await this.upsertMovie(queryRunner, normalized);

      await this.upsertMovieSourceMap(queryRunner, movieId, sourceItemId, matchedBy);
      await this.syncTaxonomies(queryRunner, movieId, normalized);
      await this.syncPeople(queryRunner, movieId, normalized);
      await this.syncSeasonsAndEpisodes(queryRunner, movieId, normalized);

      await queryRunner.query('UPDATE movies SET updated_at = NOW() WHERE id = $1', [movieId]);

      await queryRunner.commitTransaction();

      await this.enqueueSearch(movieId);

      return { movieId, matchedBy };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  private async getSourceItem(id: number): Promise<SourceItemRow | null> {
    const rows = await this.dataSource.query(
      `
      SELECT si.*, s.code AS source_code
      FROM source_items si
      JOIN sources s ON s.id = si.source_id
      WHERE si.id = $1
      `,
      [id],
    );
    return rows[0] || null;
  }

  private async upsertMovie(queryRunner: QueryRunner, normalized: MovieNormalized) {
    const matched = await this.findMovieMatch(queryRunner, normalized);
    const movieId = matched?.id;

    if (movieId) {
      await this.updateMovie(queryRunner, movieId, normalized);
      return { movieId, matchedBy: matched.matchedBy };
    }

    const slug = normalized.slugSuggested || slugify(normalized.title);
    const rows = await queryRunner.query(
      `
      INSERT INTO movies (
        slug,
        title,
        original_title,
        other_titles,
        type,
        year,
        status,
        plot,
        poster_url,
        backdrop_url,
        trailer_url,
        imdb_id,
        tmdb_id,
        is_active
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, true)
      RETURNING id;
      `,
      [
        slug,
        normalized.title,
        normalized.originalTitle || null,
        normalized.otherTitles || null,
        normalized.type,
        normalized.year || null,
        normalized.status || 'unknown',
        normalized.plot || null,
        normalized.posterUrl || null,
        normalized.backdropUrl || null,
        normalized.trailerUrl || null,
        normalized.imdbId || null,
        normalized.tmdbId || null,
      ],
    );

    return { movieId: rows[0].id, matchedBy: 'other' };
  }

  private async findMovieMatch(queryRunner: QueryRunner, normalized: MovieNormalized) {
    if (normalized.imdbId) {
      const rows = await queryRunner.query(
        'SELECT id FROM movies WHERE imdb_id = $1 LIMIT 1',
        [normalized.imdbId],
      );
      if (rows[0]) return { id: rows[0].id, matchedBy: 'imdb' };
    }

    if (normalized.tmdbId) {
      const rows = await queryRunner.query(
        'SELECT id FROM movies WHERE tmdb_id = $1 LIMIT 1',
        [normalized.tmdbId],
      );
      if (rows[0]) return { id: rows[0].id, matchedBy: 'tmdb' };
    }

    const titleKey = normalizeTitle(normalized.title);
    if (titleKey && normalized.year) {
      const rows = await queryRunner.query(
        `
        SELECT id
        FROM movies
        WHERE year = $1
          AND regexp_replace(lower(title), '[^a-z0-9]+', '', 'g') = $2
        LIMIT 1;
        `,
        [normalized.year, titleKey],
      );
      if (rows[0]) return { id: rows[0].id, matchedBy: 'title_year' };
    }

    return null;
  }

  private async updateMovie(
    queryRunner: QueryRunner,
    movieId: number,
    normalized: MovieNormalized,
  ) {
    const fields: Array<{ column: string; value: any }> = [
      { column: 'title', value: normalized.title },
      { column: 'original_title', value: normalized.originalTitle },
      { column: 'other_titles', value: normalized.otherTitles },
      { column: 'type', value: normalized.type },
      { column: 'year', value: normalized.year },
      { column: 'status', value: normalized.status },
      { column: 'plot', value: normalized.plot },
      { column: 'poster_url', value: normalized.posterUrl },
      { column: 'backdrop_url', value: normalized.backdropUrl },
      { column: 'trailer_url', value: normalized.trailerUrl },
      { column: 'imdb_id', value: normalized.imdbId },
      { column: 'tmdb_id', value: normalized.tmdbId },
    ];

    const sets: string[] = [];
    const params: any[] = [];

    for (const field of fields) {
      if (field.value === undefined || field.value === null) continue;
      params.push(field.value);
      sets.push(`${field.column} = $${params.length}`);
    }

    if (!sets.length) return;

    params.push(movieId);
    await queryRunner.query(
      `UPDATE movies SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${params.length}`,
      params,
    );
  }

  private async upsertMovieSourceMap(
    queryRunner: QueryRunner,
    movieId: number,
    sourceItemId: number,
    matchedBy: string,
  ) {
    await queryRunner.query(
      `
      INSERT INTO movie_source_map (movie_id, source_item_id, confidence, is_primary, matched_by)
      VALUES ($1, $2, $3, true, $4)
      ON CONFLICT (source_item_id)
      DO UPDATE SET movie_id = EXCLUDED.movie_id, confidence = EXCLUDED.confidence, matched_by = EXCLUDED.matched_by;
      `,
      [movieId, sourceItemId, 0.9, matchedBy],
    );
  }

  private async syncTaxonomies(
    queryRunner: QueryRunner,
    movieId: number,
    normalized: MovieNormalized,
  ) {
    const genreIds = await this.upsertTaxonomyBySlug(queryRunner, 'genres', normalized.genres);
    const tagIds = await this.upsertTaxonomyBySlug(queryRunner, 'tags', normalized.tags);
    const countryIds = await this.upsertCountries(queryRunner, normalized.countries);

    await this.syncMapping(queryRunner, 'movie_genres', 'genre_id', movieId, genreIds);
    await this.syncMapping(queryRunner, 'movie_tags', 'tag_id', movieId, tagIds);
    await this.syncMapping(queryRunner, 'movie_countries', 'country_id', movieId, countryIds);
  }

  private async upsertTaxonomyBySlug(
    queryRunner: QueryRunner,
    table: 'genres' | 'tags',
    items: TaxonomyItem[],
  ) {
    const ids: number[] = [];
    for (const item of items) {
      const slug = item.slug || slugify(item.name);
      const rows = await queryRunner.query(
        `
        INSERT INTO ${table} (name, slug)
        VALUES ($1, $2)
        ON CONFLICT (slug)
        DO UPDATE SET name = EXCLUDED.name
        RETURNING id;
        `,
        [item.name, slug],
      );
      if (rows[0]?.id) {
        ids.push(rows[0].id);
        continue;
      }
      const fallback = await queryRunner.query(`SELECT id FROM ${table} WHERE slug = $1`, [slug]);
      if (fallback[0]?.id) ids.push(fallback[0].id);
    }
    return ids;
  }

  private async upsertCountries(queryRunner: QueryRunner, items: TaxonomyItem[]) {
    const ids: number[] = [];
    for (const item of items) {
      if (item.code) {
        const rows = await queryRunner.query(
          `
          INSERT INTO countries (code, name)
          VALUES ($1, $2)
          ON CONFLICT (code)
          DO UPDATE SET name = EXCLUDED.name
          RETURNING id;
          `,
          [item.code, item.name],
        );
        if (rows[0]?.id) {
          ids.push(rows[0].id);
          continue;
        }
      }

      const existing = await queryRunner.query(
        'SELECT id FROM countries WHERE name = $1 LIMIT 1',
        [item.name],
      );
      if (existing[0]?.id) {
        ids.push(existing[0].id);
        continue;
      }

      const inserted = await queryRunner.query(
        'INSERT INTO countries (name) VALUES ($1) RETURNING id',
        [item.name],
      );
      if (inserted[0]?.id) ids.push(inserted[0].id);
    }
    return ids;
  }

  private async syncMapping(
    queryRunner: QueryRunner,
    table: 'movie_genres' | 'movie_tags' | 'movie_countries',
    column: string,
    movieId: number,
    ids: number[],
  ) {
    for (const id of ids) {
      await queryRunner.query(
        `INSERT INTO ${table} (movie_id, ${column}) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [movieId, id],
      );
    }
  }

  private async syncPeople(queryRunner: QueryRunner, movieId: number, normalized: MovieNormalized) {
    const roles: Array<{ role: string; people: PersonItem[] }> = [
      { role: 'actor', people: normalized.people.actors || [] },
      { role: 'director', people: normalized.people.directors || [] },
      { role: 'writer', people: normalized.people.writers || [] },
      { role: 'producer', people: normalized.people.producers || [] },
    ];

    for (const roleBlock of roles) {
      for (const person of roleBlock.people) {
        const personId = await this.upsertPerson(queryRunner, person);
        await queryRunner.query(
          `
          INSERT INTO movie_people (movie_id, person_id, role_type, character_name, order_index)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT DO NOTHING;
          `,
          [movieId, personId, roleBlock.role, null, 0],
        );
      }
    }
  }

  private async upsertPerson(queryRunner: QueryRunner, person: PersonItem) {
    const slug = person.slug || slugify(person.name);
    const rows = await queryRunner.query(
      `
      INSERT INTO people (name, slug, avatar_url, bio)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (slug)
      DO UPDATE SET name = EXCLUDED.name, avatar_url = EXCLUDED.avatar_url, bio = EXCLUDED.bio
      RETURNING id;
      `,
      [person.name, slug, person.avatarUrl || null, person.bio || null],
    );
    if (rows[0]?.id) return rows[0].id;
    const fallback = await queryRunner.query('SELECT id FROM people WHERE slug = $1', [slug]);
    return fallback[0].id;
  }

  private async syncSeasonsAndEpisodes(
    queryRunner: QueryRunner,
    movieId: number,
    normalized: MovieNormalized,
  ) {
    this.logger.log(`[SYNC] inserting episodes for movieId=${movieId}`);
    if (!normalized.seasons.length) return;

    for (const season of normalized.seasons) {
      const seasonId = await this.upsertSeason(queryRunner, movieId, season.seasonNumber);

      for (const episode of season.episodes) {
        const episodeId = await this.upsertEpisode(
          queryRunner,
          movieId,
          seasonId,
          episode.episodeNumber,
          episode.name,
        );

        await this.syncStreams(queryRunner, episodeId, episode.streams);
      }
    }
  }

  private async upsertSeason(queryRunner: QueryRunner, movieId: number, seasonNumber: number) {
    const rows = await queryRunner.query(
      `
      INSERT INTO seasons (movie_id, season_number, title)
      VALUES ($1, $2, $3)
      ON CONFLICT (movie_id, season_number)
      DO UPDATE SET title = EXCLUDED.title
      RETURNING id;
      `,
      [movieId, seasonNumber, `Season ${seasonNumber}`],
    );
    if (rows[0]?.id) return rows[0].id;
    const fallback = await queryRunner.query(
      'SELECT id FROM seasons WHERE movie_id = $1 AND season_number = $2',
      [movieId, seasonNumber],
    );
    return fallback[0].id;
  }

  private async upsertEpisode(
    queryRunner: QueryRunner,
    movieId: number,
    seasonId: number | null,
    episodeNumber: number,
    name: string,
  ) {
    const rows = await queryRunner.query(
      `
      INSERT INTO episodes (movie_id, season_id, episode_number, name, is_active)
      VALUES ($1, $2, $3, $4, true)
      ON CONFLICT (movie_id, season_id, episode_number)
      DO UPDATE SET name = EXCLUDED.name, is_active = true
      RETURNING id;
      `,
      [movieId, seasonId, episodeNumber, name],
    );
    if (rows[0]?.id) return rows[0].id;
    const fallback = await queryRunner.query(
      'SELECT id FROM episodes WHERE movie_id = $1 AND season_id IS NOT DISTINCT FROM $2 AND episode_number = $3',
      [movieId, seasonId, episodeNumber],
    );
    return fallback[0].id;
  }

  private async syncStreams(
    queryRunner: QueryRunner,
    episodeId: number,
    streams: MovieNormalized['seasons'][number]['episodes'][number]['streams'],
  ) {
    const grouped = new Map<string, typeof streams>();
    for (const stream of streams) {
      if (!stream.url) continue;
      const list = grouped.get(stream.serverName) || [];
      list.push(stream);
      grouped.set(stream.serverName, list);
    }

    for (const [serverName, serverStreams] of grouped.entries()) {
      const serverId = await this.upsertVideoServer(queryRunner, episodeId, serverName, serverStreams[0]);

      const checksumList: string[] = [];
      for (const stream of serverStreams) {
        const checksum = sha256(stream.url);
        checksumList.push(checksum);

        const existing = await queryRunner.query(
          `SELECT id FROM video_streams WHERE server_id = $1 AND checksum = $2 LIMIT 1`,
          [serverId, checksum],
        );

        if (existing[0]?.id) {
          await queryRunner.query(
            `\n          UPDATE video_streams\n          SET label = $1, url = $2, headers = $3, priority = $4, is_active = true\n          WHERE id = $5;\n          `,
            [
              stream.label,
              stream.url,
              stream.headers ? JSON.stringify(stream.headers) : null,
              stream.priority ?? 100,
              existing[0].id,
            ],
          );
        } else {
          await queryRunner.query(
            `\n          INSERT INTO video_streams (server_id, label, url, headers, priority, is_active, checksum)\n          VALUES ($1, $2, $3, $4, $5, true, $6);\n          `,
            [
              serverId,
              stream.label,
              stream.url,
              stream.headers ? JSON.stringify(stream.headers) : null,
              stream.priority ?? 100,
              checksum,
            ],
          );
        }
      }

      if (checksumList.length) {
        await queryRunner.query(
          `
          UPDATE video_streams
          SET is_active = false
          WHERE server_id = $1 AND checksum NOT IN (${checksumList
            .map((_, idx) => `$${idx + 2}`)
            .join(', ')});
          `,
          [serverId, ...checksumList],
        );
      } else {
        await queryRunner.query(
          `UPDATE video_streams SET is_active = false WHERE server_id = $1`,
          [serverId],
        );
      }
    }
  }

  private async upsertVideoServer(
    queryRunner: QueryRunner,
    episodeId: number,
    serverName: string,
    exampleStream: { kind: string; priority?: number | null },
  ) {
    const rows = await queryRunner.query(
      `
      INSERT INTO video_servers (episode_id, name, kind, priority, is_active)
      VALUES ($1, $2, $3, $4, true)
      ON CONFLICT (episode_id, name)
      DO UPDATE SET kind = EXCLUDED.kind, priority = EXCLUDED.priority, is_active = true
      RETURNING id;
      `,
      [episodeId, serverName, exampleStream.kind || 'hls', exampleStream.priority ?? 100],
    );
    if (rows[0]?.id) return rows[0].id;
    const fallback = await queryRunner.query(
      'SELECT id FROM video_servers WHERE episode_id = $1 AND name = $2',
      [episodeId, serverName],
    );
    return fallback[0].id;
  }

  private async enqueueSearch(movieId: number) {
    try {
      await this.dataSource.query('SELECT enqueue_movie_search($1, $2)', [movieId, 'sync']);
    } catch (error) {
      this.logger.warn('enqueue_movie_search not available, relying on triggers');
    }
  }
}
