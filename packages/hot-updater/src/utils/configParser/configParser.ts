export interface ConfigParser {
  get(key: string): Promise<{ value: string | null; path: string }>;
  set(key: string, value: string): Promise<{ path: string }>;
  exists(): Promise<boolean>;
}
