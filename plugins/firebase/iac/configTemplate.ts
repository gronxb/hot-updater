import {
  ConfigBuilder,
  createHotUpdaterConfigScaffoldFromBuilder,
  type HotUpdaterConfigScaffold,
  type ProviderConfig,
  type BuildType,
  type ManagedHelperStatement,
} from "@hot-updater/cli-tools";

/** The Firebase project, bucket, and database init set up, which the config names as they are. */
export interface FirebaseConfigResources {
  readonly projectId: string;
  readonly storageBucket: string;
  readonly databaseId: string;
}

/**
 * The config init writes. With the `resources` init set up, it names them;
 * without them, as the agent scaffold writes it, it reads them from the
 * environment. Either way it signs in with each person's own Google
 * credentials (ADC), so it reads no secret.
 */
export const getConfigScaffold = (
  build: BuildType,
  resources?: FirebaseConfigResources,
): HotUpdaterConfigScaffold => {
  const projectId =
    resources === undefined
      ? "process.env.HOT_UPDATER_FIREBASE_PROJECT_ID!"
      : JSON.stringify(resources.projectId);
  const storageConfig: ProviderConfig = {
    imports: [{ pkg: "@hot-updater/firebase", named: ["firebaseStorage"] }],
    configString: `firebaseStorage({
    projectId: ${projectId},
    storageBucket: ${
      resources === undefined
        ? "process.env.HOT_UPDATER_FIREBASE_STORAGE_BUCKET!"
        : JSON.stringify(resources.storageBucket)
    },
    credential,
  })`,
  };
  const databaseConfig: ProviderConfig = {
    imports: [{ pkg: "@hot-updater/firebase", named: ["firebaseDatabase"] }],
    configString: `firebaseDatabase({
    projectId: ${projectId},
    databaseId: ${
      resources === undefined
        ? "process.env.HOT_UPDATER_FIREBASE_DATABASE_ID"
        : JSON.stringify(resources.databaseId)
    },
    credential,
  })`,
  };

  const helperStatements: ManagedHelperStatement[] = [
    {
      name: "credential",
      strategy: "preserve-existing",
      code: `
// https://firebase.google.com/docs/admin/setup?hl=en#initialize_the_sdk_in_non-google_environments
// Reuse working application-default credentials (ADC).
// Only when a credential file is needed, set its private local path in .env.hotupdater:
// GOOGLE_APPLICATION_CREDENTIALS=./firebase-adminsdk-credentials.json
const credential = applicationDefault();`.trim(),
    },
  ];

  const builder = new ConfigBuilder()
    .setBuildType(build)
    .setStorage(storageConfig)
    .setDatabase(databaseConfig)
    .setPlugins({
      imports: [
        {
          pkg: "hot-updater/plugins",
          named: ["apiKeys", "insights", "remoteConfig"],
        },
      ],
      configString: "[apiKeys(), insights(), remoteConfig()]",
    })
    .addImport({ pkg: "firebase-admin/app", named: ["applicationDefault"] })
    .setIntermediateCode(
      helperStatements.map((statement) => statement.code.trim()).join("\n\n"),
    );

  return createHotUpdaterConfigScaffoldFromBuilder(builder, {
    helperStatements,
  });
};
