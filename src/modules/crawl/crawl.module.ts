import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { CrawlController } from './crawl.controller';
import { CrawlService, QUEUE_CRAWL_DETAIL, QUEUE_CRAWL_DISCOVER, QUEUE_SYNC_SOURCE_ITEM } from './crawl.service';
import { DiscoverProcessor } from './discover.processor';
import { DetailProcessor } from './detail.processor';
import { SyncModule } from '../sync/sync.module';
import { SyncProcessor } from './sync.processor';

@Module({
  imports: [
    SyncModule,
    BullModule.registerQueue(
      {
        name: QUEUE_CRAWL_DISCOVER,
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: true,
        },
      },
      {
        name: QUEUE_CRAWL_DETAIL,
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: true,
        },
      },
      {
        name: QUEUE_SYNC_SOURCE_ITEM,
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: true,
        },
      },
    ),
  ],
  controllers: [CrawlController],
  providers: [CrawlService, DiscoverProcessor, DetailProcessor,SyncProcessor],
  exports: [CrawlService],
})
export class CrawlModule {}
