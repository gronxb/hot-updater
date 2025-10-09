import * as p from "@clack/prompts";
import {
  type BuildType,
  ConfigBuilder,
  link,
  makeEnv,
  type ProviderConfig,
} from "@hot-updater/plugin-core";
import { ExecaError, execa } from "execa";
import fs from "fs";

const getConfigTemplate = (build: BuildType) => {
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

  const intermediate = `
// https://firebase.google.com/docs/admin/setup?hl=en#initialize_the_sdk_in_non-google_environments
// Check your .env file and add the credentials
// Set the GOOGLE_APPLICATION_CREDENTIALS environment variable to your credentials file path
// Example: GOOGLE_APPLICATION_CREDENTIALS=./firebase-adminsdk-credentials.json
const credential = admin.credential.applicationDefault();`.trim();

  return new ConfigBuilder()
    .setBuildType(build)
    .setStorage(storageConfig)
    .setDatabase(databaseConfig)
    .addImport({ pkg: "firebase-admin", defaultOrNamespace: "admin" })
    .setIntermediateCode(intermediate)
    .getResult();
};

export const setEnv = async ({
  projectId,
  storageBucket,
  build,
}: {
  projectId: string;
  storageBucket: string;
  build: BuildType;
}) => {
  await makeEnv({
    GOOGLE_APPLICATION_CREDENTIALS: {
      comment:
        "Project Settings > Service Accounts > New Private Key > Download JSON",
      value: "your-credentials.json",
    },
    HOT_UPDATER_FIREBASE_PROJECT_ID: projectId,
    HOT_UPDATER_FIREBASE_STORAGE_BUCKET: storageBucket,
  });

  p.log.success("Firebase credentials have been successfully configured.");

  try {
    await fs.promises.writeFile(
      "hot-updater.config.ts",
      getConfigTemplate(build),
    );
    p.log.success(
      "Configuration file 'hot-updater.config.ts' has been created.",
    );
  } catch (error: any) {
    console.error("Error writing configuration file:", error.message);
  }
};

const handleError = (err: unknown) => {
  if (err instanceof ExecaError) {
    p.log.error(err.stderr || err.stdout || err.message);
  } else if (err instanceof Error) {
    p.log.error(`Error occurred: ${err.message}`);
  }
  process.exit(1);
};

const listProjects = async (): Promise<
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
      ["firebase", "projects:list", "--json"],
      {
        shell: true,
      },
    );
    const projectsJson = JSON.parse(projects.stdout);
    return projectsJson?.result ?? [];
  } catch {
    return [];
  }
};

export const initFirebaseUser = async (
  cwd: string,
): Promise<{
  projectId: string;
  projectNumber: number;
  storageBucket: string;
}> => {
  try {
    await execa("npx", ["firebase", "login"], {
      stdio: "inherit",
      shell: true,
    });
  } catch (err) {
    handleError(err);
  }
  try {
    const authList = await execa("gcloud", ["auth", "list", "--format=json"], {
      shell: true,
    });
    const authListJson = JSON.parse(authList.stdout);
    if (authListJson.length === 0) {
      await execa("gcloud", ["auth", "login"], {
        stdio: "inherit",
        shell: true,
      });
    }
  } catch (err) {
    handleError(err);
  }

  const projects = await listProjects();

  const createKey = `create/${Math.random().toString(36).substring(2, 15)}`;
  const projectId = await p.select({
    message: "Select a Firebase project",
    options: [
      ...projects.map((project) => ({
        label: project.displayName,
        value: project.projectId,
      })),
      { value: createKey, label: "Create new Firebase project" },
    ],
  });

  if (p.isCancel(projectId)) {
    p.log.error("Project ID is required");
    process.exit(1);
  }
  if (projectId === createKey) {
    const newProjectId = await p.text({
      message: "Enter the Firebase project ID:",
    });
    if (p.isCancel(newProjectId)) {
      p.log.error("Project ID is required");
      process.exit(1);
    }
    try {
      await execa("npx", ["firebase", "projects:create", newProjectId], {
        stdio: "inherit",
        shell: true,
      });
      p.log.success("Firebase project created successfully");

      p.log.step(
        "Please Go to the following links to enable Firestore and Storage and Billing",
      );
      p.log.step(
        link(
          `https://console.firebase.google.com/project/${newProjectId}/firestore`,
        ),
      );
      p.log.step(
        link(
          `https://console.firebase.google.com/project/${newProjectId}/storage`,
        ),
      );
    } catch (err) {
      handleError(err);
    }
    process.exit(0);
  }

  await p.tasks([
    {
      title: `Select Firebase project (${projectId})...`,
      task: async () => {
        try {
          await execa("npx", ["firebase", "use", "--add", projectId], {
            cwd,
            shell: true,
          });
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
    const indexes = await execa("npx", ["firebase", "firestore:indexes"], {
      cwd,
      shell: true,
    });
    if (indexes.exitCode !== 0) {
      throw new Error(indexes.stderr);
    }
  } catch {
    // Create firestore database if it doesn't exist
    await execa(
      "gcloud",
      ["firestore", "databases", "describe", `--project=${projectId}`],
      {
        stdio: "inherit",
        shell: true,
      },
    );
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
            shell: true,
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
      shell: true,
    },
  );
  const projectJson = JSON.parse(project.stdout);
  const projectNumber = Number(projectJson.projectNumber);
  if (Number.isNaN(projectNumber)) {
    p.log.error("Project Number not found");
    process.exit(1);
  }

  return {
    storageBucket,
    projectNumber,
    projectId,
  };
};
