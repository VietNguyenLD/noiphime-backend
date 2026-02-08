import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { DatabaseService } from '../database/database.service';

type CollectionSeed = {
  name: string;
  slug: string;
  order: number;
  random_data: boolean;
  type: number;
  filter: Record<string, any>;
  is_published: boolean;
};

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const db = app.get(DatabaseService);

  try {
    const collections = await buildCollections(db);
    if (!collections.length) {
      console.log('No collections generated.');
      return;
    }

    for (const c of collections) {
      await db.query(
        `
        INSERT INTO collections (name, slug, "order", random_data, type, filter, is_published)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
        ON CONFLICT (slug)
        DO UPDATE SET
          name = EXCLUDED.name,
          "order" = EXCLUDED."order",
          random_data = EXCLUDED.random_data,
          type = EXCLUDED.type,
          filter = EXCLUDED.filter,
          is_published = EXCLUDED.is_published,
          updated_at = now();
        `,
        [c.name, c.slug, c.order, c.random_data, c.type, JSON.stringify(c.filter), c.is_published],
      );
    }

    console.log(`Upserted ${collections.length} collections.`);
  } finally {
    await app.close();
  }
}

async function buildCollections(db: DatabaseService): Promise<CollectionSeed[]> {
  const seeds: CollectionSeed[] = [];

  const baseFilter = (): Record<string, any> => ({
    country_code: [] as string[],
    status: 'On Going',
    type: '',
    top_views: '',
    limit: '20',
    sort_by: 'updated_at',
    order: '-1',
  });

  seeds.push({
    name: 'Phim bộ mới cập nhật',
    slug: 'phim-bo-moi-cap-nhat',
    order: 1,
    random_data: false,
    type: 2,
    filter: baseFilter(),
    is_published: true,
  });

  const topViews = [
    { name: 'Top phim bộ hôm nay', slug: 'top-phim-bo-hom-nay', top_views: 'day', order: 2 },
    { name: 'Top phim bộ tuần này', slug: 'top-phim-bo-tuan-nay', top_views: 'week', order: 3 },
    { name: 'Top phim bộ tháng này', slug: 'top-phim-bo-thang-nay', top_views: 'month', order: 4 },
  ];

  for (const item of topViews) {
    const filter = baseFilter();
    filter.top_views = item.top_views;
    seeds.push({
      name: item.name,
      slug: item.slug,
      order: item.order,
      random_data: false,
      type: 2,
      filter,
      is_published: true,
    });
  }

  const countries = await getTopCountries(db, 6);
  let order = 10;
  for (const c of countries) {
    const filter = baseFilter();
    filter.country_code = [c.code];
    seeds.push({
      name: `Phim ${c.name || c.code} mới`,
      slug: `phim-${String(c.code).toLowerCase()}-moi`,
      order,
      random_data: false,
      type: 2,
      filter,
      is_published: true,
    });
    order += 1;
  }

  const genres = await getTopGenres(db, 8);
  for (const g of genres) {
    const filter = baseFilter();
    filter.genre_slug = g.slug;
    seeds.push({
      name: `Phim ${g.name} nổi bật`,
      slug: `phim-${g.slug}-noi-bat`,
      order,
      random_data: false,
      type: 2,
      filter,
      is_published: true,
    });
    order += 1;
  }

  return seeds;
}

async function getTopCountries(db: DatabaseService, limit: number) {
  const recent = await db.query<{ code: string; name: string; total: string }>(
    `
    SELECT c.code, c.name, COUNT(*)::text AS total
    FROM movies m
    JOIN movie_countries mc ON mc.movie_id = m.id
    JOIN countries c ON c.id = mc.country_id
    WHERE m.updated_at >= now() - interval '90 days'
    GROUP BY c.code, c.name
    ORDER BY COUNT(*) DESC
    LIMIT $1;
    `,
    [limit],
  );
  if (recent.length) return recent;

  return db.query<{ code: string; name: string; total: string }>(
    `
    SELECT c.code, c.name, COUNT(*)::text AS total
    FROM movies m
    JOIN movie_countries mc ON mc.movie_id = m.id
    JOIN countries c ON c.id = mc.country_id
    GROUP BY c.code, c.name
    ORDER BY COUNT(*) DESC
    LIMIT $1;
    `,
    [limit],
  );
}

async function getTopGenres(db: DatabaseService, limit: number) {
  const recent = await db.query<{ slug: string; name: string; total: string }>(
    `
    SELECT g.slug, g.name, COUNT(*)::text AS total
    FROM movies m
    JOIN movie_genres mg ON mg.movie_id = m.id
    JOIN genres g ON g.id = mg.genre_id
    WHERE m.updated_at >= now() - interval '90 days'
    GROUP BY g.slug, g.name
    ORDER BY COUNT(*) DESC
    LIMIT $1;
    `,
    [limit],
  );
  if (recent.length) return recent;

  return db.query<{ slug: string; name: string; total: string }>(
    `
    SELECT g.slug, g.name, COUNT(*)::text AS total
    FROM movies m
    JOIN movie_genres mg ON mg.movie_id = m.id
    JOIN genres g ON g.id = mg.genre_id
    GROUP BY g.slug, g.name
    ORDER BY COUNT(*) DESC
    LIMIT $1;
    `,
    [limit],
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
