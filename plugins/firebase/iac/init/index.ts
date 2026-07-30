import type { InitProviderDefinition } from "@hot-updater/cli-tools";

export const FIREBASE_REGION_VALUES = [
  "us-central1",
  "us-east1",
  "us-east4",
  "us-west1",
  "us-west2",
  "us-west3",
  "us-west4",
  "europe-west1",
  "europe-west2",
  "europe-west3",
  "europe-west6",
  "asia-east1",
  "asia-east2",
  "asia-northeast1",
  "asia-northeast2",
  "asia-northeast3",
  "asia-south1",
  "asia-southeast1",
  "asia-southeast2",
  "australia-southeast1",
] as const;

export const isFirebaseRegion = (
  value: string | undefined,
): value is (typeof FIREBASE_REGION_VALUES)[number] =>
  value !== undefined &&
  FIREBASE_REGION_VALUES.some((region) => region === value);

export const isFirebaseProjectId = (
  value: string | undefined,
): value is string =>
  value !== undefined && /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(value);

export const initProvider = {
  label: "Firebase",
  inputs: {
    projectId: {
      envKey: "HOT_UPDATER_FIREBASE_PROJECT_ID",
      help: "Firebase project ID",
      validate: isFirebaseProjectId,
    },
    region: {
      envKey: "HOT_UPDATER_FIREBASE_REGION",
      help: "Firebase Functions region",
      prompt: {
        message: "Select Region",
        type: "select",
      },
      validate: isFirebaseRegion,
    },
    applicationCredentials: {
      envKey: "GOOGLE_APPLICATION_CREDENTIALS",
      help: "Service account JSON path",
      optional: true,
      persistence: "with-consent",
      prompt: {
        message:
          "Enter the service account JSON path (press Enter to configure later)",
        placeholder: "~/Downloads/firebase-service-account.json",
        type: "text",
      },
    },
  },
} as const satisfies InitProviderDefinition;
