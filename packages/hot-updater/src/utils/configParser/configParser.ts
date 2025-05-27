export interface ConfigParser {
  get(
    key: string,
  ): Promise<{ default?: string; [flavor: string]: string | undefined }>;
  set(
    key: string,
    value: string,
    options?: { flavor?: string },
  ): Promise<{ path: string }>;
  exists(): Promise<boolean>;
}
