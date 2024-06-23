export interface HotUpdaterReadStrategy {
  getListObjects(prefix?: string): Promise<string[]>;
}
