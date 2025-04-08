import fs from "fs";
import * as p from "@clack/prompts";
import { makeEnv } from "@hot-updater/plugin-core";
import { execa } from "execa";

const CONFIG_TEMPLATE = `import {metro} from '@hot-updater/metro';
import {firebaseStorage, firebaseDatabase} from '@hot-updater/firebase';
import {defineConfig} from 'hot-updater';
import 'dotenv/config';
export default defineConfig({
  build: metro({
    enableHermes: true,
  }),
  storage: firebaseStorage({
    projectId: process.env.HOT_UPDATER_FIREBASE_PROJECT_ID,
    privateKey: process.env.HOT_UPDATER_FIREBASE_PRIVATE_KEY,
    clientEmail:process.env.HOT_UPDATER_FIREBASE_CLIENT_EMAIL,
  }),
  database: firebaseDatabase({
    projectId: process.env.HOT_UPDATER_FIREBASE_PROJECT_ID,
    privateKey: process.env.HOT_UPDATER_FIREBASE_PRIVATE_KEY,
    clientEmail:process.env.HOT_UPDATER_FIREBASE_CLIENT_EMAIL,
  }),
});`;

interface Icred {
  projectId: string | symbol;
  privateKey: string | symbol;
  clientEmail: string | symbol;
}

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

export const setEnv = async (): Promise<string> => {
  const cred: Icred = {
    projectId: "",
    privateKey: "",
    clientEmail: "",
  };

  const jsonPath = await p.text({
    message: "Enter the Firebase SDK credentials JSON file path:",
    validate: (value: string): string | undefined => {
      if (!value) return "File path is required";
      if (!fs.existsSync(value)) return "File does not exist";
      return undefined;
    },
  });

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

  return cred.projectId as string;
};

const handleError = (err: unknown) => {
  if (err instanceof Error) {
    p.log.error(`Error occurred: ${err.message}`);
  } else {
    console.error("An unknown error occurred:", err);
  }
};

export const initFirebaseUser = async () => {
  try {
    await execa("firebase", ["login"], {
      stdio: "inherit",
    });
  } catch (err) {
    handleError(err);
  }

  const selectedProject = await setEnv();

  if (!selectedProject) {
    p.log.error("Failed to make Env and hot-updater.config.ts");
    process.exit(1);
  }

  return {
    projectId: selectedProject,
  };
};
