import type { JsonObject } from "../control-client.ts";

export type DetoxScenarioStep =
  | {
      readonly action: "launch" | "reload" | "resetAppState" | "terminate";
      readonly kind: "device";
      readonly stage: string;
    }
  | {
      readonly body?: JsonObject;
      readonly kind: "control";
      readonly pathName: string;
      readonly saveResultFieldsAs?: Readonly<Record<string, string>>;
      readonly saveResultAs?: string;
      readonly stage: string;
    }
  | {
      readonly kind: "tap";
      readonly stage: string;
      readonly testID: string;
    }
  | {
      readonly kind: "typeText";
      readonly stage: string;
      readonly testID: string;
      readonly text: string;
    }
  | {
      readonly contains: string;
      readonly kind: "assertText";
      readonly stage: string;
      readonly testID: string;
    };

export type DetoxScenarioDefinition = {
  readonly name: string;
  readonly steps: readonly DetoxScenarioStep[];
  readonly wave: 1 | 2 | 3 | 4;
};

export type DetoxScenarioWave = {
  readonly label: string;
  readonly scenarios: readonly string[];
  readonly wave: 1 | 2 | 3 | 4;
};
