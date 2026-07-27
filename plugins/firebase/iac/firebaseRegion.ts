import { MissingInitInputsError, p } from "@hot-updater/cli-tools";
import { execa } from "execa";

import type { FirebaseCliEnv } from "./firebaseInitInputs";
import {
  initProvider as FIREBASE_INIT_PROVIDER,
  isFirebaseRegion,
} from "./init/index";

const REGIONS = [
  { value: "us-central1", label: "US Central (Iowa)" },
  { value: "us-east1", label: "US East (South Carolina)" },
  { value: "us-east4", label: "US East (Northern Virginia)" },
  { value: "us-west1", label: "US West (Oregon)" },
  { value: "us-west2", label: "US West (Los Angeles)" },
  { value: "us-west3", label: "US West (Salt Lake City)" },
  { value: "us-west4", label: "US West (Las Vegas)" },
  { value: "europe-west1", label: "Europe West (Belgium)" },
  { value: "europe-west2", label: "Europe West (London)" },
  { value: "europe-west3", label: "Europe West (Frankfurt)" },
  { value: "europe-west6", label: "Europe West (Zurich)" },
  { value: "asia-east1", label: "Asia East (Taiwan)" },
  { value: "asia-east2", label: "Asia East (Hong Kong)" },
  { value: "asia-northeast1", label: "Asia Northeast (Tokyo)" },
  { value: "asia-northeast2", label: "Asia Northeast (Osaka)" },
  { value: "asia-northeast3", label: "Asia Northeast (Seoul)" },
  { value: "asia-south1", label: "Asia South (Mumbai)" },
  { value: "asia-southeast1", label: "Asia Southeast (Singapore)" },
  { value: "asia-southeast2", label: "Asia Southeast (Jakarta)" },
  {
    value: "australia-southeast1",
    label: "Australia Southeast (Sydney)",
  },
];

export const resolveFirebaseRegion = async ({
  cwd,
  discoverExistingProject = true,
  nonInteractive,
  savedRegion,
  cliEnv,
}: {
  readonly cliEnv?: FirebaseCliEnv;
  readonly cwd: string;
  readonly discoverExistingProject?: boolean;
  readonly nonInteractive?: boolean;
  readonly savedRegion?: string;
}): Promise<string> => {
  if (isFirebaseRegion(savedRegion)) {
    return savedRegion;
  }

  if (nonInteractive) {
    throw new MissingInitInputsError(["HOT_UPDATER_FIREBASE_REGION"]);
  }

  let discoveredRegion: string | undefined;
  if (discoverExistingProject) {
    const functionsList = await execa(
      "npx",
      ["firebase", "functions:list", "--json"],
      { cwd, env: cliEnv, reject: false },
    );
    if (functionsList.exitCode === 0) {
      const parsed: unknown = JSON.parse(functionsList.stdout);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "result" in parsed &&
        Array.isArray(parsed.result)
      ) {
        for (const entry of parsed.result) {
          if (
            typeof entry === "object" &&
            entry !== null &&
            "id" in entry &&
            entry.id === "hot-updater" &&
            "region" in entry &&
            typeof entry.region === "string"
          ) {
            discoveredRegion = entry.region;
            break;
          }
        }
      }
    }
  }

  if (isFirebaseRegion(discoveredRegion)) {
    return discoveredRegion;
  }

  const selectedRegion = await p.select<string>({
    message: FIREBASE_INIT_PROVIDER.inputs.region.prompt.message,
    options: REGIONS,
    initialValue: REGIONS[0].value,
  });
  if (p.isCancel(selectedRegion)) {
    p.cancel("Operation cancelled.");
    process.exit(1);
  }
  return selectedRegion;
};
