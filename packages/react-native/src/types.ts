export interface UpdateInfo {
  [appVersion: string]: {
    bundleVersion: number;
    forceUpdate: boolean;
  };
}
