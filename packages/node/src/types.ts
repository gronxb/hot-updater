export type Version =
  | `${number}.${number}.${number}`
  | `${number}.${number}`
  | `${number}`;

export type MetaDataOptions = {
  version: Version;
  reloadAfterUpdate?: boolean;
};

export interface HotUpdaterReadStrategy {
  getListObjects(prefix?: string): Promise<string[]>;
}
