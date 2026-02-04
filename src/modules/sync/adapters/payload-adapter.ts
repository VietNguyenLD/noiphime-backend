import { MovieNormalized, SourceItemRow } from '../dto/normalized.dto';

export interface PayloadAdapter {
  supports(sourceId: string): boolean;
  normalize(payload: any, sourceItem: SourceItemRow): MovieNormalized;
}
