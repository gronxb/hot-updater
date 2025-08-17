export interface ConfigParser {
  get(key: string): Promise<{ value: string | null; paths: string[] }>;
  set(key: string, value: string): Promise<{ paths: string[] }>;
  exists(): Promise<boolean>;
}
