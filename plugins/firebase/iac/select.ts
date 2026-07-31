import {
  type BuildType,
  ConfigBuilder,
  createHotUpdaterConfigScaffoldFromBuilder,
  getInitProviderTextPromptValues,
  type HotUpdaterConfigScaffold,
  link,
  makeEnv,
  type ManagedHelperStatement,
  MissingInitInputsError,
  type ProviderConfig,
  p,
  shouldAutoSelectOnlyInitResource,
  writeHotUpdaterConfig,
} from "@hot-updater/cli-tools";
import { ExecaError, execa } from "execa";

import type { FirebaseCliEnv } from "./firebaseInitInputs";
import {
  initProvider as FIREBASE_INIT_PROVIDER,
  isFirebaseProjectId,
} from "./init/index";

const getConfigScaffold = (build: BuildType): HotUpdaterConfigScaffold => {
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

  const helperStatements: ManagedHelperStatement[] = [
    {
      name: "credential",
      strategy: "preserve-existing",
      code: `
// https://firebase.google.com/docs/admin/setup?hl=en#initialize_the_sdk_in_non-google_environments
// Check your .env file and add the credentials
// Set the GOOGLE_APPLICATION_CREDENTIALS environment variable to your credentials file path
// Example: GOOGLE_APPLICATION_CREDENTIALS=./firebase-adminsdk-credentials.json
const credential = admin.credential.applicationDefault();`.trim(),
    },
  ];

  const builder = new ConfigBuilder()
    .setBuildType(build)
    .setStorage(storageConfig)
    .setDatabase(databaseConfig)
    .addImport({ pkg: "firebase-admin", defaultOrNamespace: "admin" })
    .setIntermediateCode(
      helperStatements.map((statement) => statement.code.trim()).join("\n\n"),
    );

  return createHotUpdaterConfigScaffoldFromBuilder(builder, {
    helperStatements,
  });
};

export const setEnv = async ({
  applicationCredentials,
  projectId,
  storageBucket,
  build,
  region,
}: {
  applicationCredentials?: string;
  projectId: string;
  storageBucket: string;
  build: BuildType;
  region: string;
}) => {
  await makeEnv(
    {
      [FIREBASE_INIT_PROVIDER.inputs.applicationCredentials.envKey]: {
        comment:
          "Project Settings > Service Accounts > New Private Key > Download JSON",
        value: applicationCredentials ?? "your-credentials.json",
      },
      [FIREBASE_INIT_PROVIDER.inputs.projectId.envKey]: projectId,
      [FIREBASE_INIT_PROVIDER.inputs.region.envKey]: region,
      HOT_UPDATER_FIREBASE_STORAGE_BUCKET: storageBucket,
    },
    ".env.hotupdater",
    {
      preserveKeys: applicationCredentials
        ? []
        : [FIREBASE_INIT_PROVIDER.inputs.applicationCredentials.envKey],
    },
  );

  p.log.success("Firebase credentials have been successfully configured.");

  try {
    const configWriteResult = await writeHotUpdaterConfig(
      getConfigScaffold(build),
    );
    if (configWriteResult.status === "created") {
      p.log.success(
        "Configuration file 'hot-updater.config.ts' has been created.",
      );
    } else if (configWriteResult.status === "merged") {
      p.log.success(
        "Configuration file 'hot-updater.config.ts' has been updated.",
      );
    } else {
      p.log.warn(
        `Existing 'hot-updater.config.ts' was left unchanged: ${configWriteResult.reason}`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Error writing configuration file:", message);
  }
};

const handleError: (err: unknown) => never = (err) => {
  if (err instanceof ExecaError) {
    p.log.error(err.stderr || err.stdout || err.message);
  } else if (err instanceof Error) {
    p.log.error(`Error occurred: ${err.message}`);
  }
  process.exit(1);
};

export type FirebaseUserInitialization =
  | {
      readonly status: "create";
      readonly projectId: string;
    }
  | {
      readonly status: "ready";
      readonly projectId: string;
      readonly projectNumber: number;
      readonly storageBucket: string;
    };

type ResolveFirebaseCliEnv = (
  projectId: string,
) => Promise<FirebaseCliEnv | undefined>;

export const createFirebaseProject = async ({
  cliEnv,
  projectId,
}: {
  readonly cliEnv?: FirebaseCliEnv;
  readonly projectId: string;
}): Promise<void> => {
  if (!isFirebaseProjectId(projectId)) {
    throw new Error(`Invalid Firebase project ID: ${projectId}`);
  }

  try {
    await execa(
      "npx",
      [
        "firebase",
        "projects:create",
        `--display-name=${projectId}`,
        "--non-interactive",
        "--",
        projectId,
      ],
      {
        env: cliEnv,
        stdio: "inherit",
      },
    );
  } catch (error) {
    handleError(error instanceof Error ? error : new Error(String(error)));
  }

  p.log.success("Firebase project created successfully");
  p.log.step(
    "Enable Firestore, Storage, and Billing before running init again:",
  );
  p.log.step(
    link(`https://console.firebase.google.com/project/${projectId}/firestore`),
  );
  p.log.step(
    link(`https://console.firebase.google.com/project/${projectId}/storage`),
  );
};

const listProjects = async (
  nonInteractive = false,
  cliEnv?: FirebaseCliEnv,
): Promise<
  {
    projectId: string;
    projectNumber: string;
    displayName: string;
    name: string;
    state: string;
    etag: string;
  }[]
> => {
  try {
    const projects = await execa(
      "npx",
      [
        "firebase",
        "projects:list",
        "--json",
        ...(nonInteractive ? ["--non-interactive"] : []),
      ],
      {
        env: cliEnv,
      },
    );
    const projectsJson = JSON.parse(projects.stdout);
    return projectsJson?.result ?? [];
  } catch (error) {
    if (nonInteractive) {
      throw new MissingInitInputsError([
        "Firebase CLI authentication (`firebase login`)",
      ]);
    }
    throw error;
  }
};

export const initFirebaseUser = async (
  cwd: string,
  preferredProjectId?: string,
  nonInteractive = false,
  cliEnv?: FirebaseCliEnv,
  resolveCliEnv?: ResolveFirebaseCliEnv,
): Promise<FirebaseUserInitialization> => {
  if (!cliEnv) {
    try {
      const authList = await execa(
        "gcloud",
        ["auth", "list", "--format=json"],
        {
          env: cliEnv,
        },
      );
      const authListJson = JSON.parse(authList.stdout);
      if (authListJson.length === 0) {
        if (nonInteractive) {
          throw new MissingInitInputsError([
            "active gcloud authentication (`gcloud auth login`)",
          ]);
        }
        await execa("gcloud", ["auth", "login"], {
          env: cliEnv,
          stdio: "inherit",
        });
      }
    } catch (err) {
      if (err instanceof MissingInitInputsError) {
        throw err;
      }
      handleError(err);
    }
  }

  let projects: Awaited<ReturnType<typeof listProjects>>;
  try {
    projects = await listProjects(nonInteractive, cliEnv);
  } catch (error) {
    if (nonInteractive || cliEnv) {
      throw error;
    }
    try {
      await execa("npx", ["firebase", "login"], {
        env: cliEnv,
        stdio: "inherit",
      });
      projects = await listProjects(false, cliEnv);
    } catch (loginError) {
      handleError(
        loginError instanceof Error
          ? loginError
          : new Error(String(loginError)),
      );
    }
  }

  const createKey = `create/${Math.random().toString(36).substring(2, 15)}`;
  const preferredProject = projects.find(
    (project) => project.projectId === preferredProjectId,
  );
  if (preferredProjectId && !preferredProject) {
    if (nonInteractive) {
      throw new MissingInitInputsError(["HOT_UPDATER_FIREBASE_PROJECT_ID"]);
    }
    p.log.warn("Saved Firebase project was not found. Select a project again.");
  }
  const onlyProject = shouldAutoSelectOnlyInitResource({
    availableResourceCount: projects.length,
    savedIdentifier: preferredProjectId,
  })
    ? projects[0]
    : undefined;
  if (!preferredProject && onlyProject) {
    p.log.info("Using the only Firebase project.");
  }
  const projectId =
    preferredProject?.projectId ??
    onlyProject?.projectId ??
    (await p.select({
      message: "Select a Firebase project",
      options: [
        ...projects.map((project) => ({
          label: project.displayName,
          value: project.projectId,
        })),
        { value: createKey, label: "Create new Firebase project" },
      ],
    }));

  if (p.isCancel(projectId)) {
    p.log.error("Project ID is required");
    process.exit(1);
  }
  if (projectId === createKey) {
    const prompt = FIREBASE_INIT_PROVIDER.inputs.projectId.prompt;
    const newProjectId = await p.text({
      ...getInitProviderTextPromptValues(prompt, preferredProjectId),
      message: prompt.message,
      validate: (value) =>
        isFirebaseProjectId(value)
          ? undefined
          : "Use 6-30 lowercase letters, numbers, or hyphens; start with a letter and end with a letter or number.",
    });
    if (p.isCancel(newProjectId)) {
      p.log.error("Project ID is required");
      process.exit(1);
    }
    return {
      status: "create",
      projectId: newProjectId,
    };
  }

  const selectedProjectCliEnv = resolveCliEnv
    ? await resolveCliEnv(projectId)
    : cliEnv;

  await p.tasks([
    {
      title: `Select Firebase project (${projectId})...`,
      task: async () => {
        try {
          await execa(
            "npx",
            [
              "firebase",
              "use",
              ...(nonInteractive ? [] : ["--add"]),
              projectId,
              ...(nonInteractive ? ["--non-interactive"] : []),
            ],
            {
              cwd,
              env: selectedProjectCliEnv,
            },
          );
        } catch (error) {
          if (error instanceof ExecaError) {
            p.log.error(error.stderr || error.stdout || error.message);
          } else if (error instanceof Error) {
            p.log.error(error.message);
          }
          process.exit(1);
        }
      },
    },
  ]);

  try {
    const databases = await execa(
      "gcloud",
      [
        "firestore",
        "databases",
        "list",
        `--project=${projectId}`,
        "--format=json",
      ],
      {
        env: selectedProjectCliEnv,
        /**
         * API [firestore.googleapis.com] not enabled on project [xxx]. Would you
         like to enable and retry (this will take a few minutes)? (y/N)?
         */
        input: "N\n",
      },
    );
    const databasesJson = JSON.parse(databases.stdout);

    if (databasesJson.length === 0) {
      p.log.warning("Firestore Database not found");
      p.log.step("Please enable Firestore in the Firebase Console:");
      p.log.step(
        link(
          `https://console.firebase.google.com/project/${projectId}/firestore`,
        ),
      );
      p.log.step(
        "After enabling Firestore, please run 'npx hot-updater init' again.",
      );
      process.exit(1);
    }
  } catch (err) {
    handleError(err instanceof Error ? err : new Error(String(err)));
  }

  let storageBucket: string | null = null;
  await p.tasks([
    {
      title: "Getting storage bucket...",
      task: async () => {
        const buckets = await execa(
          "gcloud",
          [
            "storage",
            "buckets",
            "list",
            `--project=${projectId}`,
            "--format=json",
          ],
          {
            env: selectedProjectCliEnv,
          },
        );
        const bucketsJson = JSON.parse(buckets.stdout);
        storageBucket = bucketsJson.find(
          (bucket: { name: string }) =>
            bucket.name === `${projectId}.firebasestorage.app` ||
            bucket.name === `${projectId}.appspot.com`,
        )?.name;

        if (!storageBucket) {
          p.log.error("Storage Bucket not found");
          p.log.step(
            "Please Go to the following links to enable Firestore and Storage and Billing",
          );
          p.log.step(
            link(
              `https://console.firebase.google.com/project/${projectId}/firestore`,
            ),
          );
          process.exit(1);
        }
        return `Storage Bucket: ${storageBucket}`;
      },
    },
  ]);
  if (!storageBucket) {
    p.log.error("Storage Bucket not found");
    process.exit(1);
  }

  const project = await execa(
    "gcloud",
    ["projects", "describe", projectId, "--format=json"],
    {
      env: selectedProjectCliEnv,
    },
  );
  const projectJson = JSON.parse(project.stdout);
  const projectNumber = Number(projectJson.projectNumber);
  if (Number.isNaN(projectNumber)) {
    p.log.error("Project Number not found");
    process.exit(1);
  }

  return {
    status: "ready",
    storageBucket,
    projectNumber,
    projectId,
  };
};
