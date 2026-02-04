export interface DiscoveredItem {
  externalId: string;
  externalUrl?: string | null;
  type?: 'single' | 'series' | null;
  title?: string | null;
  year?: number | null;
}

export interface SourceCrawler {
  discover(page: number): Promise<DiscoveredItem[]>;
  detail(externalId: string): Promise<any>;
}
