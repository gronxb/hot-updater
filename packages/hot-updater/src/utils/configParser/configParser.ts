export interface ConfigParser {
  get(key: string): Promise<{ value: string | null; path: string | null }>;
  set(key: string, value: string): Promise<{ path: string | null }>;
  exists(): Promise<boolean>;
}
