import type { JsonObject } from "../control-client.ts";

export type ControlOptions = {
  readonly saveResultAs?: string;
  readonly saveResultFieldsAs?: Readonly<Record<string, string>>;
};

export type AssertTextOptions = {
  readonly exactText?: boolean;
  readonly ensureForeground?: boolean;
};

export type LaunchOptions = {
  readonly allowDisconnect?: boolean;
  readonly expectCrash?: boolean;
};

export type ScenarioAppDriver = {
  readonly assertText: (
    stage: string,
    testID: string,
    contains: string | readonly string[],
    options?: AssertTextOptions,
  ) => Promise<void>;
  readonly control: (
    stage: string,
    pathName: string,
    body?: JsonObject,
    options?: ControlOptions,
  ) => Promise<void>;
  readonly launch: (stage: string, options?: LaunchOptions) => Promise<void>;
  readonly reload: (stage: string) => Promise<void>;
  readonly resetAppState: (stage: string) => Promise<void>;
  readonly tap: (stage: string, testID: string) => Promise<void>;
  readonly terminate: (stage: string) => Promise<void>;
  readonly typeText: (
    stage: string,
    testID: string,
    text: string,
  ) => Promise<void>;
};

export type ScenarioDefinition = {
  readonly name: string;
  readonly run: (app: ScenarioAppDriver) => Promise<void>;
};
