export type Version =
  | `${number}.${number}.${number}`
  | `${number}.${number}`
  | `${number}`;

export type HotUpdaterMetaData = {
  files: string[];
  version: Version;
  id: string;
};
