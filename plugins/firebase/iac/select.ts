import * as p from "@clack/prompts";
import { link } from "@hot-updater/plugin-core";
import { execa } from "execa";

interface Project {
  projectId: string;
  projectNumber: string;
  displayName: string;
  name: string;
  resources?: {
    hostingSite?: string;
  };
  state: string;
  etag: string;
}

interface WebApp {
  appId: string;
  displayName: string;
  projectId: string;
}

const spin = p.spinner();

export const selectOrCreateProject = async (): Promise<string> => {
  spin.start("fetching projects list...");
  try {
    const listProjects = await execa("firebase", ["projects:list", "--json"], {
      stdio: "pipe",
    });
    spin.stop();
    const projects: Project[] = JSON.parse(listProjects.stdout).result || [];

    const projectOptions = [
      ...projects.map((project) => ({
        value: project.projectId,
        label: `${project.displayName} (${project.projectId})`,
      })),
      {
        value: "CREATE_NEW",
        label: "Create a New Project",
      },
    ];

    const selectedProjectId = await p.select({
      message: "Select a Firebase project",
      options: projectOptions,
    });

    if (selectedProjectId === "CREATE_NEW") {
      const projectName = await p.text({
        message: "Enter the name for your new Firebase project",
        validate(value) {
          if (!value || value === undefined) {
            return "App name is required.";
          }
          return;
        },
      });

      if (p.isCancel(projectName)) process.exit(0);

      await execa("firebase", ["projects:create", projectName as string], {
        stdio: "inherit",
      });

      p.log.info(`
        ==================================================================================
                                  Storage Setup Instructions
        ==================================================================================
        1. Please complete the Storage and FireStore setup on the Firebase Console.
        2. Note: Upgrading your plan to 'Blaze' is required to proceed.
        storage: ${link(`https://console.firebase.google.com/project/${projectName as string}/storage`)}
        firestore: ${link(`https://console.firebase.google.com/project/${projectName as string}/firestore`)}
        ==================================================================================
        `);

      const hasCheckedInstructions = await p.confirm({
        message:
          "Have you completed the Storage and Firestore setup on Firebase Console?",
        initialValue: false,
      });

      if (p.isCancel(hasCheckedInstructions)) process.exit(0);

      if (!hasCheckedInstructions) {
        p.log.warn("Please complete the setup before continuing.");
        process.exit(0);
      }

      return projectName as string;
    }

    return selectedProjectId as string;
  } catch (err) {
    handleError(err);
    process.exit(1);
  }
};

export const selectOrCreateWebApp = async (
  projectId: string,
): Promise<string> => {
  try {
    spin.start("fetching apps list ...");
    const listApps = await execa(
      "firebase",
      ["apps:list", "WEB", "--project", projectId, "--json"],
      {
        stdio: "pipe",
      },
    );
    spin.stop();

    const apps: WebApp[] = JSON.parse(listApps.stdout).result || [];

    const appOptions = [
      ...apps.map((app) => ({
        value: app.appId,
        label: `${app.displayName} (${app.appId})`,
      })),
      {
        value: "CREATE_NEW",
        label: "Create a New Web App",
      },
    ];

    const selectedAppId = await p.select({
      message: "Select a web app",
      options: appOptions,
    });

    if (selectedAppId === "CREATE_NEW") {
      const appName = await p.text({
        message: "Enter the name for your web app",
        validate(value) {
          if (!value || value === undefined) {
            return "App name is required.";
          }
          return;
        },
      });

      if (p.isCancel(appName)) process.exit(0);

      await execa(
        "firebase",
        ["apps:create", "WEB", appName as string, "--project", projectId],
        {
          stdio: "inherit",
        },
      );

      const listNewApps = await execa(
        "firebase",
        ["apps:list", "WEB", "--project", projectId, "--json"],
        {
          stdio: "pipe",
        },
      );
      const newApps: WebApp[] = JSON.parse(listNewApps.stdout).result || [];
      const newApp = newApps.find((app) => app.displayName === appName);

      if (!newApp) {
        throw new Error(`Could not find the new web app '${appName}'.`);
      }

      return newApp.appId;
    }

    return selectedAppId as string;
  } catch (err) {
    handleError(err);
    process.exit(1);
  }
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

  const selectedProject = await selectOrCreateProject();
  if (!selectedProject) {
    p.log.error("Failed to select or create a Firebase project.");
    process.exit(1);
  }
  const selectedWebApp = await selectOrCreateWebApp(selectedProject);
  if (!selectedWebApp) {
    p.log.error("Failed to select or create a web app.");
    process.exit(1);
  }

  return {
    projectId: selectedProject,
    webAppId: selectedWebApp,
  };
};
