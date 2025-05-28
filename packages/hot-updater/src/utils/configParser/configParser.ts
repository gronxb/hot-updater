export interface ConfigParser {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<{ path: string }>;
  exists(): Promise<boolean>;
}
