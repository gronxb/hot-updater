import type { InitProviderDefinition } from "../initProvider";

export const FIREBASE_INIT_PROVIDER = {
  label: "Firebase",
  inputs: {
    projectId: {
      envKey: "HOT_UPDATER_FIREBASE_PROJECT_ID",
      help: "Firebase project ID",
    },
    region: {
      envKey: "HOT_UPDATER_FIREBASE_REGION",
      help: "Firebase Functions region",
      prompt: {
        message: "Select Region",
        type: "select",
      },
    },
    applicationCredentials: {
      envKey: "GOOGLE_APPLICATION_CREDENTIALS",
      help: "Service account JSON path",
      optional: true,
      persistence: "with-consent",
      prompt: {
        message:
          "Enter the service account JSON path (press Enter to configure later)",
        type: "text",
      },
    },
  },
} as const satisfies InitProviderDefinition;
