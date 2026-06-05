import type { JsonObject } from "../control-client.ts";

export type DetoxControlOptions = {
  readonly saveResultAs?: string;
  readonly saveResultFieldsAs?: Readonly<Record<string, string>>;
};

export type DetoxAssertTextOptions = {
  readonly ensureForeground?: boolean;
};

export type DetoxScenarioDriver = {
  readonly assertText: (
    stage: string,
    testID: string,
    contains: string,
    options?: DetoxAssertTextOptions,
  ) => Promise<void>;
  readonly control: (
    stage: string,
    pathName: string,
    body?: JsonObject,
    options?: DetoxControlOptions,
  ) => Promise<void>;
  readonly launch: (stage: string) => Promise<void>;
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

export type DetoxScenarioDefinition = {
  readonly name: string;
  readonly run: (scenario: DetoxScenarioDriver) => Promise<void>;
  readonly stages: readonly string[];
  readonly wave: 1 | 2 | 3 | 4;
};

export type DetoxScenarioWave = {
  readonly label: string;
  readonly scenarios: readonly string[];
  readonly wave: 1 | 2 | 3 | 4;
};
