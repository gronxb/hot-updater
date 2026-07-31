import type { InitProviderDefinition } from "@hot-updater/cli-tools";

export const isFirebaseRegion = (value: string | undefined): value is string =>
  value !== undefined && /^[a-z]+(?:-[a-z]+)+[0-9]+$/.test(value);

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
      prompt: {
        message: "Enter the Firebase project ID:",
        placeholder: "hot-updater-app",
        type: "text",
      },
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
