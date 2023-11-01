export type Version =
  | `${number}.${number}.${number}`
  | `${number}.${number}`
  | `${number}`;

export type MetaDataOptions = {
  version: Version;
  reloadAfterUpdate?: boolean;
};
