import axios from 'axios';
import { DiscoveredItem, SourceCrawler } from './source-crawler.interface';

export class KkphimCrawlerAdapter implements SourceCrawler {
  constructor(
    private readonly baseUrl: string,
    private readonly listPath: string,
    private readonly detailPath: string,
  ) {}

  async discover(page: number): Promise<DiscoveredItem[]> {
    const url = this.buildUrl(this.listPath, { page });
    const res = await axios.get(url, { timeout: 15000 });
    const items = res.data?.items || res.data?.data?.items || [];

    return items.map((item: any) => ({
      externalId: String(item?.slug || item?._id || item?.id),
      externalUrl: item?.link || item?.url || null,
      type: item?.type === 'series' ? 'series' : item?.type === 'single' ? 'single' : null,
      title: item?.name || item?.title || null,
      year: item?.year ? Number(item.year) : null,
    }));
  }

  async detail(externalId: string): Promise<any> {
    const url = this.buildUrl(this.detailPath, { slug: externalId });
    const res = await axios.get(url, { timeout: 15000 });
    return res.data;
  }

  private buildUrl(path: string, params: Record<string, string | number>) {
    const replaced = path.replace(/\{(\w+)\}/g, (_, key) => String(params[key] ?? ''));
    const url = new URL(replaced, this.baseUrl);
    return url.toString();
  }
}
