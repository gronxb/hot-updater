export interface UpdatePayload {
  [appVersion: string]: {
    bundleVersion: number;
    forceUpdate: boolean;
  };
}

export type UpdatePayloadArg =
  | UpdatePayload
  | (() => Promise<UpdatePayload>)
  | (() => UpdatePayload);
