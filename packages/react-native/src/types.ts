import { Platform } from "react-native";

export type Version =
  | `${number}.${number}.${number}`
  | `${number}.${number}`
  | `${number}`;

/**
 * Metadata associated with a hot update.
 */
export type HotUpdaterMetaData = {
  /**
   * List of files associated with the update.
   */
  files: string[];

  /**
   * Version information for the update.
   */
  version: Version;

  /**
   * Unique identifier for the update. This is used as a prefix when downloading files.
   */
  id: string;

  /**
   * Indicates whether the application should reload after the update is applied.
   */
  reloadAfterUpdate?: boolean;
};

export interface UpdateInfo {
  [appVersion: string]: {
    bundleVersion: number;
    forceUpdate: boolean;
  };
}
