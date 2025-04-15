import fs from "fs";
import path from "path";
import * as p from "@clack/prompts";
import { link, makeEnv } from "@hot-updater/plugin-core";
import { ExecaError, execa } from "execa";
import picocolors from "picocolors";

const CONFIG_TEMPLATE = `import { metro } from '@hot-updater/metro';
import {firebaseStorage, firebaseDatabase} from '@hot-updater/firebase';
import { cert } from "firebase-admin/app";
import { defineConfig } from 'hot-updater';
import 'dotenv/config';

export default defineConfig({
  build: metro({
    enableHermes: true,
  }),
  storage: firebaseStorage({
    projectId: process.env.HOT_UPDATER_FIREBASE_PROJECT_ID,
    credential: cert({
      projectId: process.env.HOT_UPDATER_FIREBASE_PROJECT_ID,
      privateKey: process.env.HOT_UPDATER_FIREBASE_PRIVATE_KEY,
      clientEmail: process.env.HOT_UPDATER_FIREBASE_CLIENT_EMAIL,
    }),
  }),
  database: firebaseDatabase({
    projectId: process.env.HOT_UPDATER_FIREBASE_PROJECT_ID,
    credential: cert({
      projectId: process.env.HOT_UPDATER_FIREBASE_PROJECT_ID,
      privateKey: process.env.HOT_UPDATER_FIREBASE_PRIVATE_KEY,
      clientEmail: process.env.HOT_UPDATER_FIREBASE_CLIENT_EMAIL,
    }),
  }),
});`;

async function addToGitignore(): Promise<void> {
  const addContent = "*firebase*adminsdk*.json";
  try {
    let gitignoreContent = "";

    if (fs.existsSync(".gitignore")) {
      gitignoreContent = await fs.promises.readFile(".gitignore", "utf8");

      if (gitignoreContent.includes(addContent)) {
        p.log.info(`${addContent} is already in .gitignore file.`);
        return;
      }

      if (!gitignoreContent.endsWith("\n")) {
        gitignoreContent += "\n";
      }
    }

    gitignoreContent += `${addContent}\n`;

    await fs.promises.writeFile(".gitignore", gitignoreContent);
    p.log.success(`${addContent} has been successfully added to .gitignore.`);
  } catch (error: any) {
    console.error("Error updating .gitignore file:", error.message);
  }
}

export const setEnv = async (): Promise<{
  projectId: string;
  privateKey: string;
  clientEmail: string;
}> => {
  const cred: {
    projectId: string | null;
    privateKey: string | null;
    clientEmail: string | null;
  } = {
    projectId: null,
    privateKey: null,
    clientEmail: null,
  };

  p.log.message(picocolors.blue("The following infrastructure is required:"));
  p.log.message(`${picocolors.blue("Firebase Project")}`);
  p.log.message(`${picocolors.blue("Firebase Storage")}`);
  p.log.message(`${picocolors.blue("Firestore Database")}`);
  p.log.message(
    `${picocolors.blue("Firebase SDK credentials JSON")}: Project settings -> Service accounts -> Firebase Admin SDK -> Generate new private key`,
  );

  const defaultPath = path.join(process.cwd(), "firebase-credentials.json");
  const jsonPath = await p.text({
    message: "Enter the Firebase SDK credentials JSON file path:",
    placeholder: "firebase-credentials.json",
    defaultValue: defaultPath,
    validate: (value: string): string | undefined => {
      if (!fs.existsSync(value || defaultPath)) {
        return "File does not exist";
      }
      return undefined;
    },
  });
  if (p.isCancel(jsonPath)) {
    p.log.error("Firebase credentials JSON file path is required");
    process.exit(1);
  }

  await addToGitignore();

  try {
    const fileContent: string = await fs.promises.readFile(
      jsonPath as string,
      "utf8",
    );
    const credentials: {
      project_id: string;
      private_key: string;
      client_email: string;
    } = JSON.parse(fileContent);

    cred.projectId = credentials.project_id;
    cred.privateKey = credentials.private_key;
    cred.clientEmail = credentials.client_email;

    if (!cred.projectId) {
      console.error("Could not find project_id in the JSON file");
      process.exit(1);
    }
    if (!cred.privateKey) {
      console.error("Could not find private_key in the JSON file");
      process.exit(1);
    }
    if (!cred.clientEmail) {
      console.error("Could not find client_email in the JSON file");
      process.exit(1);
    }

    p.log.success(`Found project ID: ${cred.projectId}`);
  } catch (error: any) {
    console.error("Error reading JSON file:", error.message);
    process.exit(1);
  }

  await makeEnv({
    HOT_UPDATER_FIREBASE_PROJECT_ID: cred.projectId as string,
    HOT_UPDATER_FIREBASE_PRIVATE_KEY: `"${cred.privateKey as string}"`,
    HOT_UPDATER_FIREBASE_CLIENT_EMAIL: cred.clientEmail as string,
  });

  p.log.success("Firebase credentials have been successfully configured.");

  try {
    await fs.promises.writeFile("hot-updater.config.ts", CONFIG_TEMPLATE);
    p.log.success(
      "Configuration file 'hot-updater.config.ts' has been created.",
    );
  } catch (error: any) {
    console.error("Error writing configuration file:", error.message);
  }

  if (!cred.projectId || !cred.privateKey || !cred.clientEmail) {
    p.log.error("Failed to make Env and hot-updater.config.ts");
    process.exit(1);
  }

  return {
    projectId: cred.projectId,
    clientEmail: cred.clientEmail,
    privateKey: cred.privateKey,
  };
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
  } catch (err) {
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
    const authList = await execa("gcloud", ["auth", "list", "--format=json"]);
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
    });
    if (indexes.exitCode !== 0) {
      throw new Error(indexes.stderr);
    }
  } catch (err) {
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
        const buckets = await execa("gcloud", [
          "storage",
          "buckets",
          "list",
          `--project=${projectId}`,
          "--format=json",
        ]);
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

  const project = await execa("gcloud", [
    "projects",
    "describe",
    projectId,
    "--format=json",
  ]);
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
