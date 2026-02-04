import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import { DataSource, QueryRunner } from 'typeorm';
import { Queue } from 'bullmq';
import axios from 'axios';
import { ConfigService } from '@nestjs/config';
import { DiscoveredItem, SourceCrawler } from './adapters/source-crawler.interface';
import { OphimCrawlerAdapter } from './adapters/ophim.adapter';
import { KkphimCrawlerAdapter } from './adapters/kkphim.adapter';
import { sha256FromJson } from './utils/hash';

export const QUEUE_CRAWL_DISCOVER = 'crawl-discover';
export const QUEUE_CRAWL_DETAIL = 'crawl-detail';
export const QUEUE_SYNC_SOURCE_ITEM = 'sync-source-item';

interface SourceConfig {
  code: string;
  baseUrl: string;
  listPath: string;
  detailPath: string;
}

@Injectable()
export class CrawlService implements OnModuleInit {
  private readonly logger = new Logger(CrawlService.name);
  private readonly crawlers = new Map<string, SourceCrawler>();
  private readonly enabledSources = new Set<string>();

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
    @InjectQueue(QUEUE_CRAWL_DISCOVER) private readonly discoverQueue: Queue,
    @InjectQueue(QUEUE_CRAWL_DETAIL) private readonly detailQueue: Queue,
    @InjectQueue(QUEUE_SYNC_SOURCE_ITEM) private readonly syncQueue: Queue,
  ) {}

  async onModuleInit() {
    await this.initializeCrawlers();
    await this.ensureRepeatableJobs();
  }

  async enqueueDiscover(sourceCode: string, page = 1) {
    this.assertSourceEnabled(sourceCode);
    await this.discoverQueue.add(
      'discover',
      { source: sourceCode, page },
      { removeOnComplete: true, attempts: 3, backoff: { type: 'exponential', delay: 5000 } },
    );
    return { queued: true };
  }

  async enqueueDetail(sourceCode: string, externalId: string) {
    this.assertSourceEnabled(sourceCode);
    await this.detailQueue.add(
      'detail',
      { source: sourceCode, externalId },
      { removeOnComplete: true, attempts: 3, backoff: { type: 'exponential', delay: 5000 } },
    );
    return { queued: true };
  }

  async discover(sourceCode: string, page = 1) {
    this.assertSourceEnabled(sourceCode);
    const crawler = this.getCrawler(sourceCode);
    const source = await this.getSourceByCode(sourceCode);

    const items = await crawler.discover(page);
    const upserted: number[] = [];

    for (const item of items) {
      try {
        if (!item.externalId) continue;
        const id = await this.upsertSourceItem(source.id, item);
        if (id) {
          upserted.push(id);
          await this.detailQueue.add(
            'detail',
            { source: sourceCode, externalId: item.externalId },
            { attempts: 3, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: true },
          );
        }
      } catch (error: any) {
        await this.insertCrawlLog(null, null, 'error', 'discover item failed', {
          source: sourceCode,
          externalId: item.externalId,
          error: error?.message,
        });
      }
    }

    return { total: items.length, upserted: upserted.length };
  }

  async detail(sourceCode: string, externalId: string) {
    this.assertSourceEnabled(sourceCode);
    const crawler = this.getCrawler(sourceCode);
    const source = await this.getSourceByCode(sourceCode);

    let payload: any;
    try {
      payload = await crawler.detail(externalId);
    } catch (error: any) {
      await this.markSourceItemError(source.id, externalId, error, error?.config?.url);
      return { ok: false, error: error?.message };
    }

    const contentHash = sha256FromJson(payload);
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const sourceItem = await this.getSourceItem(source.id, externalId, queryRunner);
      let sourceItemId: number;

      if (!sourceItem) {
        sourceItemId = await this.createSourceItem(queryRunner, source.id, externalId, payload, contentHash);
        await queryRunner.commitTransaction();
        await this.syncQueue.add(
          'sync',
          { sourceItemId },
          { attempts: 3, backoff: { type: 'exponential', delay: 5000 } },
        );
        return { sourceItemId, changed: true };
      }

      const changed = sourceItem.content_hash !== contentHash;
      if (changed) {
        await this.updateSourceItemDetail(queryRunner, sourceItem.id, payload, contentHash, 'ok');
      } else {
        await this.updateSourceItemLastCrawled(queryRunner, sourceItem.id);
      }

      await queryRunner.commitTransaction();

      if (changed) {
        await this.syncQueue.add(
          'sync',
          { sourceItemId: sourceItem.id },
          { attempts: 3, backoff: { type: 'exponential', delay: 5000 } },
        );
      }

      return { sourceItemId: sourceItem.id, changed };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      await this.markSourceItemError(source.id, externalId, error);
      return { ok: false };
    } finally {
      await queryRunner.release();
    }
  }

  private async initializeCrawlers() {
    const configs = this.getConfigsFromEnv();
    for (const config of configs) {
      const sourceRow = await this.getSourceByCode(config.code);
      if (sourceRow.base_url && sourceRow.base_url !== config.baseUrl) {
        this.logger.error(`Source ${config.code} base_url mismatch: DB=${sourceRow.base_url} ENV=${config.baseUrl}`);
        continue;
      }

      if (!sourceRow.base_url) {
        await this.dataSource.query('UPDATE sources SET base_url = $1 WHERE id = $2', [
          config.baseUrl,
          sourceRow.id,
        ]);
      }

      const crawler = config.code === 'ophim'
        ? new OphimCrawlerAdapter(config.baseUrl, config.listPath, config.detailPath)
        : new KkphimCrawlerAdapter(config.baseUrl, config.listPath, config.detailPath);

      this.crawlers.set(config.code, crawler);
      this.enabledSources.add(config.code);
    }
  }

  private async ensureRepeatableJobs() {
    for (const sourceCode of this.enabledSources) {
      await this.discoverQueue.add(
        `discover-${sourceCode}`,
        { source: sourceCode, page: 1 },
        { repeat: { pattern: '*/10 * * * *' }, removeOnComplete: true },
      );
    }
  }

  private getConfigsFromEnv(): SourceConfig[] {
    const configs: SourceConfig[] = [];

    const ophimBase = this.configService.get<string>('OPHIM_BASE_URL');
    const ophimList = this.configService.get<string>('OPHIM_LIST_PATH');
    const ophimDetail = this.configService.get<string>('OPHIM_DETAIL_PATH');
    if (ophimBase && ophimList && ophimDetail) {
      configs.push({ code: 'ophim', baseUrl: ophimBase, listPath: ophimList, detailPath: ophimDetail });
    }

    const kkBase = this.configService.get<string>('KKPHIM_BASE_URL');
    const kkList = this.configService.get<string>('KKPHIM_LIST_PATH');
    const kkDetail = this.configService.get<string>('KKPHIM_DETAIL_PATH');
    if (kkBase && kkList && kkDetail) {
      configs.push({ code: 'kkphim', baseUrl: kkBase, listPath: kkList, detailPath: kkDetail });
    }

    return configs;
  }

  private assertSourceEnabled(code: string) {
    if (!this.enabledSources.has(code)) {
      throw new Error(`Crawler disabled or misconfigured for source: ${code}`);
    }
  }

  private getCrawler(code: string) {
    const crawler = this.crawlers.get(code);
    if (!crawler) throw new Error(`Crawler not available for ${code}`);
    return crawler;
  }

  private async getSourceByCode(code: string) {
    const rows = await this.dataSource.query('SELECT * FROM sources WHERE code = $1 LIMIT 1', [code]);
    if (!rows[0]) throw new Error(`Source not found: ${code}`);
    return rows[0];
  }

  private async upsertSourceItem(sourceId: number, item: DiscoveredItem) {
    const rows = await this.dataSource.query(
      `
      INSERT INTO source_items (source_id, external_id, external_url, type, title, year, crawl_status)
      VALUES ($1, $2, $3, $4, $5, $6, 'unknown')
      ON CONFLICT (source_id, external_id)
      DO UPDATE SET external_url = EXCLUDED.external_url, title = EXCLUDED.title, year = EXCLUDED.year, type = EXCLUDED.type
      RETURNING id;
      `,
      [sourceId, item.externalId, item.externalUrl || null, item.type || null, item.title || null, item.year || null],
    );
    return rows[0]?.id || null;
  }

  private async getSourceItem(sourceId: number, externalId: string, queryRunner?: QueryRunner) {
    const runner = queryRunner || this.dataSource;
    const rows = await runner.query(
      `SELECT * FROM source_items WHERE source_id = $1 AND external_id = $2 LIMIT 1`,
      [sourceId, externalId],
    );
    return rows[0] || null;
  }

  private async createSourceItem(
    queryRunner: QueryRunner,
    sourceId: number,
    externalId: string,
    payload: any,
    contentHash: string,
  ) {
    const rows = await queryRunner.query(
      `
      INSERT INTO source_items (source_id, external_id, payload, content_hash, crawl_status, last_crawled_at)
      VALUES ($1, $2, $3, $4, 'ok', NOW())
      RETURNING id;
      `,
      [sourceId, externalId, payload, contentHash],
    );
    return rows[0].id;
  }

  private async updateSourceItemDetail(
    queryRunner: QueryRunner,
    id: number,
    payload: any,
    contentHash: string,
    status: 'ok',
  ) {
    await queryRunner.query(
      `
      UPDATE source_items
      SET payload = $1,
          content_hash = $2,
          crawl_status = $3,
          last_crawled_at = NOW()
      WHERE id = $4;
      `,
      [payload, contentHash, status, id],
    );
  }

  private async updateSourceItemLastCrawled(queryRunner: QueryRunner, id: number) {
    await queryRunner.query(
      `UPDATE source_items SET last_crawled_at = NOW() WHERE id = $1`,
      [id],
    );
  }

  private async markSourceItemError(sourceId: number, externalId: string, error: any, url?: string) {
    const sourceItem = await this.getSourceItem(sourceId, externalId);
    if (sourceItem?.id) {
      await this.dataSource.query(
        `UPDATE source_items SET crawl_status = 'error' WHERE id = $1`,
        [sourceItem.id],
      );
    }

    await this.insertCrawlLog(null, sourceItem?.id || null, 'error', error?.message || 'crawl error', {
      status: error?.response?.status || null,
      url: url || error?.config?.url || null,
    });
  }

  private async insertCrawlLog(
    jobId: number | null,
    sourceItemId: number | null,
    level: 'info' | 'warn' | 'error',
    message: string,
    meta: Record<string, any> | null,
  ) {
    await this.dataSource.query(
      `
      INSERT INTO crawl_logs (job_id, source_item_id, level, message, meta)
      VALUES ($1, $2, $3, $4, $5)
      `,
      [jobId, sourceItemId, level, message, meta ? JSON.stringify(meta) : null],
    );
  }
}
