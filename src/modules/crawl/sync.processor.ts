import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { SyncService } from '../sync/sync.service';
import { QUEUE_SYNC_SOURCE_ITEM } from './crawl.service';

@Processor(QUEUE_SYNC_SOURCE_ITEM)
export class SyncProcessor extends WorkerHost {
  constructor(private readonly syncService: SyncService) {
    super();
  }

  async process(job: Job) {
    const sourceItemId = Number(job.data?.sourceItemId);
    if (!sourceItemId) {
      throw new Error('Invalid sourceItemId');
    }

    return this.syncService.syncSourceItem(sourceItemId);
  }
}
