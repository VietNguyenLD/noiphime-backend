import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, QueryRunner } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { PayloadAdapter } from './adapters/payload-adapter';
import { OphimPayloadAdapter } from './adapters/ophim.adapter';
import { KkphimPayloadAdapter } from './adapters/kkphim.adapter';
import {
  MovieNormalized,
  PersonItem,
  SourceItemRow,
  StreamItem,
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

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
  ) {}

  async syncSourceItem(sourceItemId: number) {
    const sourceItem = await this.getSourceItem(sourceItemId);
    this.logger.log(`[SYNC] start sourceItem=${sourceItemId}`);
    if (!sourceItem) return null;

    const adapter = this.adapters.find((item) => item.supports(sourceItem.source_code));
    if (!adapter) {
      throw new Error(`No adapter for source_id: ${sourceItem.source_id}`);
    }

    const normalized = adapter.normalize(sourceItem.payload, sourceItem);
    const externalPeople = sourceItem.external_id
      ? await this.fetchExternalPeople(sourceItem.source_code, sourceItem.external_id)
      : null;
    this.logger.log(
      `[SYNC] normalized sourceItem=${sourceItemId} seasons=${normalized.seasons?.length ?? 0} eps=${normalized.seasons?.[0]?.episodes?.length ?? 0}`,
    );

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const { movieId, matchedBy } = await this.upsertMovie(queryRunner, normalized);

      await this.upsertMovieSourceMap(queryRunner, movieId, sourceItemId, matchedBy);
      let mergedNormalized = normalized;
      try {
        mergedNormalized = await this.buildMergedNormalized(queryRunner, movieId);
      } catch (error) {
        this.logger.warn(
          `[SYNC] merge skipped movieId=${movieId} reason=${(error as Error)?.message || 'unknown'}`,
        );
      }

      await this.updateMovie(queryRunner, movieId, mergedNormalized);
      await this.syncTaxonomies(queryRunner, movieId, mergedNormalized);
      await this.syncPeople(queryRunner, movieId, mergedNormalized);
      if (externalPeople?.peoples?.length) {
        await this.syncExternalPeople(queryRunner, movieId, externalPeople.peoples);
      }
      await this.syncSeasonsAndEpisodes(queryRunner, movieId, mergedNormalized);

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

  private async buildMergedNormalized(queryRunner: QueryRunner, movieId: number): Promise<MovieNormalized> {
    const rows = await queryRunner.query(
      `
      SELECT si.*, s.code AS source_code
      FROM movie_source_map msm
      JOIN source_items si ON si.id = msm.source_item_id
      JOIN sources s ON s.id = si.source_id
      WHERE msm.movie_id = $1
        AND si.crawl_status = 'ok'
        AND si.payload IS NOT NULL
      `,
      [movieId],
    );

    const candidates: MovieNormalized[] = [];
    for (const row of rows as SourceItemRow[]) {
      const sourceItem = row as SourceItemRow;
      if (!sourceItem.payload || !Object.keys(sourceItem.payload).length) continue;
      const adapter = this.adapters.find((item) => item.supports(sourceItem.source_code));
      if (!adapter) continue;
      candidates.push(adapter.normalize(sourceItem.payload, sourceItem));
    }

    if (!candidates.length) {
      throw new Error(`No source payload ready to merge for movieId=${movieId}`);
    }

    const ranked = candidates.sort((a, b) => this.scoreNormalized(b) - this.scoreNormalized(a));
    const primary = ranked[0];

    const merged: MovieNormalized = {
      slugSuggested: primary.slugSuggested,
      title: primary.title,
      originalTitle: primary.originalTitle || null,
      otherTitles: [...this.toStringArray(primary.otherTitles)],
      type: primary.type,
      year: primary.year || null,
      status: primary.status || 'unknown',
      durationMin: primary.durationMin ?? null,
      quality: primary.quality ?? null,
      subtitle: primary.subtitle ?? null,
      viewCount: primary.viewCount ?? null,
      ratingAvg: primary.ratingAvg ?? null,
      ratingCount: primary.ratingCount ?? null,
      plot: primary.plot || null,
      posterUrl: primary.posterUrl || null,
      backdropUrl: primary.backdropUrl || null,
      trailerUrl: primary.trailerUrl || null,
      imdbId: primary.imdbId || null,
      tmdbId: primary.tmdbId || null,
      genres: [...(primary.genres || [])],
      countries: [...(primary.countries || [])],
      tags: [...(primary.tags || [])],
      people: {
        actors: [...(primary.people?.actors || [])],
        directors: [...(primary.people?.directors || [])],
        writers: [...(primary.people?.writers || [])],
        producers: [...(primary.people?.producers || [])],
      },
      seasons: this.mergeSeasons([], primary.seasons || []),
    };

    for (const candidate of ranked.slice(1)) {
      if (!merged.originalTitle && candidate.originalTitle) merged.originalTitle = candidate.originalTitle;
      if (!merged.year && candidate.year) merged.year = candidate.year;
      if (merged.status === 'unknown' && candidate.status && candidate.status !== 'unknown') merged.status = candidate.status;
      if (!merged.durationMin && candidate.durationMin) merged.durationMin = candidate.durationMin;
      if (!merged.quality && candidate.quality) merged.quality = candidate.quality;
      if (!merged.subtitle && candidate.subtitle) merged.subtitle = candidate.subtitle;
      if (!merged.viewCount && candidate.viewCount !== null && candidate.viewCount !== undefined) {
        merged.viewCount = candidate.viewCount;
      } else if (
        merged.viewCount !== null &&
        merged.viewCount !== undefined &&
        candidate.viewCount !== null &&
        candidate.viewCount !== undefined
      ) {
        merged.viewCount = Math.max(merged.viewCount, candidate.viewCount);
      }
      if (
        candidate.ratingAvg !== null &&
        candidate.ratingAvg !== undefined &&
        (merged.ratingAvg === null ||
          merged.ratingAvg === undefined ||
          (candidate.ratingCount || 0) > (merged.ratingCount || 0))
      ) {
        merged.ratingAvg = candidate.ratingAvg;
        merged.ratingCount = candidate.ratingCount ?? merged.ratingCount ?? null;
      } else if (merged.ratingCount === null || merged.ratingCount === undefined) {
        merged.ratingCount = candidate.ratingCount ?? merged.ratingCount ?? null;
      }
      if (!merged.plot && candidate.plot) merged.plot = candidate.plot;
      if (!merged.posterUrl && candidate.posterUrl) merged.posterUrl = candidate.posterUrl;
      if (!merged.backdropUrl && candidate.backdropUrl) merged.backdropUrl = candidate.backdropUrl;
      if (!merged.trailerUrl && candidate.trailerUrl) merged.trailerUrl = candidate.trailerUrl;
      if (!merged.imdbId && candidate.imdbId) merged.imdbId = candidate.imdbId;
      if (!merged.tmdbId && candidate.tmdbId) merged.tmdbId = candidate.tmdbId;
      if (merged.type !== 'series' && candidate.type === 'series') merged.type = 'series';

      merged.otherTitles = this.unionStrings(merged.otherTitles || [], this.toStringArray(candidate.otherTitles));
      merged.genres = this.unionTaxonomies(merged.genres, candidate.genres || []);
      merged.countries = this.unionTaxonomies(merged.countries, candidate.countries || []);
      merged.tags = this.unionTaxonomies(merged.tags, candidate.tags || []);
      merged.people.actors = this.unionPeople(merged.people.actors || [], candidate.people?.actors || []);
      merged.people.directors = this.unionPeople(merged.people.directors || [], candidate.people?.directors || []);
      merged.people.writers = this.unionPeople(merged.people.writers || [], candidate.people?.writers || []);
      merged.people.producers = this.unionPeople(merged.people.producers || [], candidate.people?.producers || []);
      merged.seasons = this.mergeSeasons(merged.seasons, candidate.seasons || []);
    }

    return merged;
  }

  private scoreNormalized(normalized: MovieNormalized): number {
    const seasonsCount = normalized.seasons?.length || 0;
    const episodesCount = (normalized.seasons || []).reduce((acc, season) => acc + (season.episodes?.length || 0), 0);
    const streamsCount = (normalized.seasons || []).reduce(
      (acc, season) => acc + (season.episodes || []).reduce((epAcc, ep) => epAcc + (ep.streams?.length || 0), 0),
      0,
    );
    const peopleCount =
      (normalized.people?.actors?.length || 0) +
      (normalized.people?.directors?.length || 0) +
      (normalized.people?.writers?.length || 0) +
      (normalized.people?.producers?.length || 0);
    const taxonomyCount =
      (normalized.genres?.length || 0) + (normalized.tags?.length || 0) + (normalized.countries?.length || 0);
    const plotScore = normalized.plot ? Math.min(normalized.plot.length, 500) : 0;
    const idScore = (normalized.imdbId ? 100 : 0) + (normalized.tmdbId ? 100 : 0);
    return plotScore + idScore + seasonsCount * 30 + episodesCount * 50 + streamsCount * 20 + peopleCount * 8 + taxonomyCount * 6;
  }

  private unionStrings(base: string[], extra: string[]) {
    const map = new Map<string, string>();
    for (const text of [...base, ...extra]) {
      const value = String(text || '').trim();
      if (!value) continue;
      const key = normalizeTitle(value);
      if (!key) continue;
      if (!map.has(key)) map.set(key, value);
    }
    return Array.from(map.values());
  }

  private toStringArray(value: unknown): string[] {
    if (Array.isArray(value)) {
      return value.map((item) => String(item || '').trim()).filter(Boolean);
    }
    if (typeof value === 'string') {
      const trimmed = value.trim();
      return trimmed ? [trimmed] : [];
    }
    if (value && typeof value === 'object') {
      return Object.values(value as Record<string, unknown>)
        .map((item) => String(item || '').trim())
        .filter(Boolean);
    }
    return [];
  }

  private unionTaxonomies(base: TaxonomyItem[], extra: TaxonomyItem[]) {
    const map = new Map<string, TaxonomyItem>();
    for (const item of [...base, ...extra]) {
      const name = String(item?.name || '').trim();
      if (!name) continue;
      const slug = item?.slug ? String(item.slug).trim() : '';
      const code = item?.code ? String(item.code).trim() : '';
      const key = slug || code || normalizeTitle(name);
      if (!key || map.has(key)) continue;
      map.set(key, { name, slug: slug || undefined, code: code || undefined });
    }
    return Array.from(map.values());
  }

  private unionPeople(base: PersonItem[], extra: PersonItem[]) {
    const map = new Map<string, PersonItem>();
    for (const person of [...base, ...extra]) {
      const name = String(person?.name || '').trim();
      if (!name) continue;
      const slug = person?.slug ? String(person.slug).trim() : '';
      const key = slug || normalizeTitle(name);
      if (!key || map.has(key)) continue;
      map.set(key, { name, slug: slug || undefined, avatarUrl: person.avatarUrl, bio: person.bio });
    }
    return Array.from(map.values());
  }

  private mergeSeasons(base: MovieNormalized['seasons'], extra: MovieNormalized['seasons']) {
    const seasonMap = new Map<number, { seasonNumber: number; episodes: MovieNormalized['seasons'][number]['episodes'] }>();
    for (const season of base) {
      seasonMap.set(season.seasonNumber, { seasonNumber: season.seasonNumber, episodes: [...season.episodes] });
    }

    for (const season of extra) {
      const target = seasonMap.get(season.seasonNumber) || { seasonNumber: season.seasonNumber, episodes: [] };
      const episodeMap = new Map<number, MovieNormalized['seasons'][number]['episodes'][number]>();

      for (const episode of target.episodes) {
        episodeMap.set(episode.episodeNumber, { ...episode, streams: [...episode.streams] });
      }

      for (const episode of season.episodes || []) {
        const existing = episodeMap.get(episode.episodeNumber);
        if (!existing) {
          episodeMap.set(episode.episodeNumber, { ...episode, streams: [...(episode.streams || [])] });
          continue;
        }
        existing.name = existing.name || episode.name;
        existing.streams = this.unionStreams(existing.streams || [], episode.streams || []);
        episodeMap.set(episode.episodeNumber, existing);
      }

      target.episodes = Array.from(episodeMap.values()).sort((a, b) => a.episodeNumber - b.episodeNumber);
      seasonMap.set(season.seasonNumber, target);
    }

    return Array.from(seasonMap.values()).sort((a, b) => a.seasonNumber - b.seasonNumber);
  }

  private unionStreams(base: StreamItem[], extra: StreamItem[]) {
    const map = new Map<string, StreamItem>();
    for (const stream of [...base, ...extra]) {
      const url = String(stream?.url || '').trim();
      if (!url) continue;
      const serverName = String(stream?.serverName || 'Server').trim() || 'Server';
      const key = `${normalizeTitle(serverName)}|${sha256(url)}`;
      if (map.has(key)) continue;
      map.set(key, {
        serverName,
        kind: stream.kind || 'hls',
        label: stream.label || 'Default',
        url,
        headers: stream.headers || null,
        priority: stream.priority ?? 100,
      });
    }
    return Array.from(map.values());
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
    const ratingAvg = this.clampRatingAvg(normalized.ratingAvg);
    const ratingCount = this.clampInt(normalized.ratingCount);
    const viewCount = this.clampBigInt(normalized.viewCount);

    const rows = await queryRunner.query(
      `
      INSERT INTO movies (
        slug,
        title,
        original_title,
        other_titles,
        type,
        year,
        duration_min,
        status,
        quality,
        subtitle,
        plot,
        poster_url,
        backdrop_url,
        trailer_url,
        imdb_id,
        tmdb_id,
        view_count,
        rating_avg,
        rating_count,
        is_active
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, true)
      RETURNING id;
      `,
      [
        slug,
        normalized.title,
        normalized.originalTitle || null,
        normalized.otherTitles ? JSON.stringify(normalized.otherTitles) : null,
        normalized.type,
        normalized.year || null,
        normalized.durationMin || null,
        normalized.status || 'unknown',
        normalized.quality || null,
        normalized.subtitle || null,
        normalized.plot || null,
        normalized.posterUrl || null,
        normalized.backdropUrl || null,
        normalized.trailerUrl || null,
        normalized.imdbId || null,
        normalized.tmdbId || null,
        viewCount ?? 0,
        ratingAvg ?? 0,
        ratingCount ?? 0,
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
    const ratingAvg = this.clampRatingAvg(normalized.ratingAvg);
    const ratingCount = this.clampInt(normalized.ratingCount);
    const viewCount = this.clampBigInt(normalized.viewCount);

    const fields: Array<{ column: string; value: any }> = [
      { column: 'title', value: normalized.title },
      { column: 'original_title', value: normalized.originalTitle },
      { column: 'other_titles', value: normalized.otherTitles },
      { column: 'type', value: normalized.type },
      { column: 'year', value: normalized.year },
      { column: 'status', value: normalized.status },
      { column: 'duration_min', value: normalized.durationMin },
      { column: 'quality', value: normalized.quality },
      { column: 'subtitle', value: normalized.subtitle },
      { column: 'plot', value: normalized.plot },
      { column: 'poster_url', value: normalized.posterUrl },
      { column: 'backdrop_url', value: normalized.backdropUrl },
      { column: 'trailer_url', value: normalized.trailerUrl },
      { column: 'imdb_id', value: normalized.imdbId },
      { column: 'tmdb_id', value: normalized.tmdbId },
      { column: 'view_count', value: viewCount },
      { column: 'rating_avg', value: ratingAvg },
      { column: 'rating_count', value: ratingCount },
    ];

    const sets: string[] = [];
    const params: any[] = [];

    for (const field of fields) {
      if (field.value === undefined || field.value === null) continue;
      if (field.column === 'other_titles' && field.value !== null && field.value !== undefined) {
        const jsonValue = typeof field.value === 'string' ? field.value : JSON.stringify(field.value);
        params.push(jsonValue);
      } else {
        params.push(field.value);
      }
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
      const code = item.code ? String(item.code).slice(0, 16) : null;
      if (code) {
        const rows = await queryRunner.query(
          `
          INSERT INTO countries (code, name)
          VALUES ($1, $2)
          ON CONFLICT (code)
          DO UPDATE SET name = EXCLUDED.name
          RETURNING id;
          `,
          [code, item.name],
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

  private async fetchExternalPeople(sourceCode: string, slug: string) {
    const isOphim = sourceCode === 'ophim';
    const baseUrl = isOphim
      ? this.configService.get<string>('OPHIM_BASE_URL') || process.env.OPHIM_BASE_URL
      : this.configService.get<string>('KKPHIM_BASE_URL') || process.env.KKPHIM_BASE_URL;
    const path = isOphim
      ? this.configService.get<string>('OPHIM_PEOPLE_PATH') ||
        process.env.OPHIM_PEOPLE_PATH ||
        '/v1/api/phim/{slug}/peoples'
      : this.configService.get<string>('KKPHIM_PEOPLE_PATH') ||
        process.env.KKPHIM_PEOPLE_PATH ||
        '/v1/api/phim/{slug}/peoples';
    if (!baseUrl) return null;

    const replaced = path.replace(/\{(\w+)\}/g, (_, key) => (key === 'slug' ? String(slug) : ''));
    const url = new URL(replaced, baseUrl).toString();

    try {
      const res = await axios.get(url, { timeout: 15000 });
      const data = res.data?.data || null;
      const peopleCount = Array.isArray(data?.peoples) ? data.peoples.length : 0;
      const sampleProfile = data?.peoples?.find((p: any) => p?.profile_path)?.profile_path || null;
      this.logger.log(
        `[SYNC] people fetched source=${sourceCode} slug=${slug} count=${peopleCount} sample_profile=${sampleProfile || 'null'}`,
      );
      return data;
    } catch (error: any) {
      this.logger.warn(`[SYNC] people fetch failed source=${sourceCode} slug=${slug} error=${error?.message}`);
      return null;
    }
  }

  private mapDepartmentToRole(dept: string | null | undefined) {
    const normalized = String(dept || '').toLowerCase().trim();
    if (normalized === 'acting') return 'actor';
    if (normalized === 'directing') return 'director';
    if (normalized === 'writing') return 'writer';
    if (normalized === 'production') return 'producer';
    return 'other';
  }

  private async syncExternalPeople(
    queryRunner: QueryRunner,
    movieId: number,
    peoples: Array<{
      tmdb_people_id?: number | string | null;
      name?: string | null;
      original_name?: string | null;
      character?: string | null;
      known_for_department?: string | null;
      profile_path?: string | null;
    }>,
  ) {
    let orderIndex = 0;
    for (const person of peoples) {
      const name = (person.name || person.original_name || '').trim();
      if (!name) continue;

      const avatarUrl = person.profile_path || undefined;
      const existingByName = await queryRunner.query(
        'SELECT id, avatar_url FROM people WHERE trim(name) = trim($1) LIMIT 1',
        [name],
      );

      let personId: number;
      if (existingByName[0]?.id) {
        personId = existingByName[0].id;
        if (avatarUrl) {
          await queryRunner.query(
            "UPDATE people SET avatar_url = $1 WHERE trim(name) = trim($2) AND (avatar_url IS NULL OR avatar_url = '')",
            [avatarUrl, name],
          );
        }
      } else {
        const tmdbId = person.tmdb_people_id ? String(person.tmdb_people_id).trim() : '';
        const slug = tmdbId ? slugify(`${name}-${tmdbId}`) : slugify(name);
        personId = await this.upsertPerson(queryRunner, {
          name,
          slug,
          avatarUrl,
        });
      }

      const roleType = this.mapDepartmentToRole(person.known_for_department);
      const character = person.character ? String(person.character).trim() : null;

      await queryRunner.query(
        `
        INSERT INTO movie_people (movie_id, person_id, role_type, character_name, order_index)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT DO NOTHING;
        `,
        [movieId, personId, roleType, character, orderIndex],
      );

      orderIndex += 1;
    }
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

  private clampRatingAvg(value: number | null | undefined): number | null {
    if (value === null || value === undefined) return null;
    const num = Number(value);
    if (!Number.isFinite(num)) return null;
    const clamped = Math.min(9.99, Math.max(0, num));
    return Math.round(clamped * 100) / 100;
  }

  private clampInt(value: number | null | undefined): number | null {
    if (value === null || value === undefined) return null;
    const num = Number(value);
    if (!Number.isFinite(num)) return null;
    const clamped = Math.min(2147483647, Math.max(0, Math.floor(num)));
    return clamped;
  }

  private clampBigInt(value: number | null | undefined): number | null {
    if (value === null || value === undefined) return null;
    const num = Number(value);
    if (!Number.isFinite(num)) return null;
    const clamped = Math.min(9_223_372_036_854_775_807, Math.max(0, Math.floor(num)));
    return clamped;
  }
}
