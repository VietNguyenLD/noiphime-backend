import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { CrawlService, QUEUE_CRAWL_DETAIL } from './crawl.service';

@Processor(QUEUE_CRAWL_DETAIL)
export class DetailProcessor extends WorkerHost {
  constructor(private readonly crawlService: CrawlService) {
    super();
  }

  async process(job: Job) {
    const { source, externalId } = job.data;
    try {
      return await this.crawlService.detail(source, externalId);
    } catch (error) {
      return { ok: false };
    }
  }
}
