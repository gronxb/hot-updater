import {
  ConfigBuilder,
  createHotUpdaterConfigScaffoldFromBuilder,
  type HotUpdaterConfigScaffold,
  type ProviderConfig,
  type BuildType,
} from "@hot-updater/cli-tools";

export const getConfigScaffold = (
  build: BuildType,
): HotUpdaterConfigScaffold => {
  const storageConfig: ProviderConfig = {
    imports: [{ pkg: "@hot-updater/firebase", named: ["firebaseStorage"] }],
    configString: `firebaseStorage({
    projectId: process.env.HOT_UPDATER_FIREBASE_PROJECT_ID!,
    storageBucket: process.env.HOT_UPDATER_FIREBASE_STORAGE_BUCKET!,
    credential,
  })`,
  };
  const databaseConfig: ProviderConfig = {
    imports: [{ pkg: "@hot-updater/firebase", named: ["firebaseDatabase"] }],
    configString: `firebaseDatabase({
    projectId: process.env.HOT_UPDATER_FIREBASE_PROJECT_ID!,
    credential,
  })`,
  };

  const builder = new ConfigBuilder()
    .setBuildType(build)
    .setStorage(storageConfig)
    .setDatabase(databaseConfig)
    .setPlugins({
      imports: [{ pkg: "@hot-updater/firebase", named: ["plugins"] }],
      configString: "plugins",
    })
    .addImport({ pkg: "firebase-admin/app", named: ["applicationDefault"] })
    .setIntermediateCode(`
// https://firebase.google.com/docs/admin/setup?hl=en#initialize_the_sdk_in_non-google_environments
// Reuse working application-default credentials (ADC).
// Only when a credential file is needed, set its private local path in .env.hotupdater:
// GOOGLE_APPLICATION_CREDENTIALS=./firebase-adminsdk-credentials.json
const credential = applicationDefault();`);

  return createHotUpdaterConfigScaffoldFromBuilder(builder);
};

/**
 * The server definitions this provider's init writes, whatever the build,
 * which another provider's init replaces when it finds one unedited.
 */
export const serverDefinitions = (): readonly string[] => [
  getConfigScaffold("bare").definition.text,
];
