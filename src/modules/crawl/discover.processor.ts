import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { CrawlService, QUEUE_CRAWL_DISCOVER } from './crawl.service';

@Processor(QUEUE_CRAWL_DISCOVER)
export class DiscoverProcessor extends WorkerHost {
  constructor(private readonly crawlService: CrawlService) {
    super();
  }

  async process(job: Job) {
    const { source, page } = job.data;
    try {
      return await this.crawlService.discover(source, page || 1);
    } catch (error) {
      return { ok: false };
    }
  }
}
