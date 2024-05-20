export interface UpdatePayload {
  [appVersion: string]: {
    bundleVersion: number;
    forceUpdate: boolean;
    enabled: boolean;
    files: string[];
  }[];
}

export type UpdatePayloadArg =
  | UpdatePayload
  | (() => Promise<UpdatePayload>)
  | (() => UpdatePayload);
