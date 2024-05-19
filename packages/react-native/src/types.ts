export interface UpdatePayload {
  [appVersion: string]: {
    bundleVersion: number;
    forceUpdate: boolean;
    enabled: boolean;
  }[];
}

export type UpdatePayloadArg =
  | UpdatePayload
  | (() => Promise<UpdatePayload>)
  | (() => UpdatePayload);
