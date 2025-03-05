import * as p from "@clack/prompts";
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

export const selectOrCreateProject = async (): Promise<Project> => {
  const confirmed = await p.confirm({
    message: "Do you already have a Firebase project?",
    initialValue: true,
  });

  if (p.isCancel(confirmed)) process.exit(0);

  try {
    if (confirmed) {
      // Fetch the existing projects list and let the user select one.
      const listProjects = await execa(
        "firebase",
        ["projects:list", "--json"],
        {
          stdio: "pipe",
        },
      );
      const projects: Project[] = JSON.parse(listProjects.stdout).result || [];

      if (projects.length === 0) {
        p.log.warn("No existing projects found. Creating a new project.");
        return await createNewProject();
      }

      const selectedProject = (await p.select<Project>({
        message: "Select a Firebase project",
        options: projects.map((project) => ({
          value: project,
          label: `${project.displayName} (${project.projectId})`,
        })),
      })) as Project;

      return selectedProject;
      // biome-ignore lint/style/noUselessElse: <explanation>
    } else {
      // Create a new project.
      return await createNewProject();
    }
  } catch (err) {
    handleError(err);
    process.exit(1);
  }
};

// Delay function (Promise-based)
const delay = (ms: number) => new Promise((res) => setTimeout(res, ms));

const createNewProject = async (): Promise<Project> => {
  const projectName = await p.text({
    message: "Enter the name for your new Firebase project",
    validate(value) {
      if (!value || value === undefined) {
        return "Project name is required.";
      }
      return;
    },
  });

  if (p.isCancel(projectName)) process.exit(0);
  const spin = p.spinner();
  try {
    await execa("firebase", ["projects:create", projectName as string], {
      stdio: "inherit",
    });

    // Poll until the project appears in the list.
    let newProject: Project | undefined;
    const startTime = Date.now();
    const timeout = 60000; // 60 seconds timeout
    spin.start();

    p.log.info(
      `Checking for project '${projectName}' to appear (up to 30 seconds)...`,
    );

    while (!newProject) {
      if (Date.now() - startTime > timeout) {
        throw new Error(
          `Timeout: Could not find project '${projectName}' within 30 seconds.`,
        );
      }

      await delay(1000); // 1 second delay

      const listProjects = await execa(
        "firebase",
        ["projects:list", "--json"],
        {
          stdio: "pipe",
        },
      );
      const projects: Project[] = JSON.parse(listProjects.stdout).result || [];
      newProject = projects.find((p) => p.displayName === projectName);
    }

    p.log.success(`Project '${projectName}' has been confirmed!`);
    spin.stop();
    return newProject;
  } catch (err) {
    handleError(err);
    process.exit(1);
  }
};

const selectOrCreateWebApp = async (projectId: string): Promise<WebApp> => {
  const confirmed = await p.confirm({
    message: "Do you create a new web app?",
    initialValue: true,
  });

  if (p.isCancel(confirmed)) process.exit(0);

  try {
    if (confirmed) {
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

      const listApps = await execa(
        "firebase",
        ["apps:list", "WEB", "--project", projectId, "--json"],
        {
          stdio: "pipe",
        },
      );
      const apps: WebApp[] = JSON.parse(listApps.stdout).result || [];
      const newApp = apps.find((app) => app.displayName === appName);
      if (!newApp) {
        throw new Error(`Could not find the new web app '${appName}'.`);
      }
      return newApp;
      // biome-ignore lint/style/noUselessElse: <explanation>
    } else {
      const listApps = await execa(
        "firebase",
        ["apps:list", "WEB", "--project", projectId, "--json"],
        {
          stdio: "pipe",
        },
      );
      const apps: WebApp[] = JSON.parse(listApps.stdout).result || [];

      if (apps.length === 0) {
        p.log.warn("No existing web apps found. Creating a new web app.");
        return await selectOrCreateWebApp(projectId);
      }

      const selectedApp = (await p.select<WebApp>({
        message: "Select a web app",
        options: apps.map((app) => ({
          value: app,
          label: `${app.displayName} (${app.appId})`,
        })),
      })) as WebApp;

      return selectedApp;
    }
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

export const initFirebase = async () => {
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
  const selectedWebApp = await selectOrCreateWebApp(selectedProject.projectId);
  if (!selectedWebApp) {
    p.log.error("Failed to select or create a web app.");
    process.exit(1);
  }

  return {
    projectId: selectedProject.projectId,
    webAppId: selectedWebApp.appId,
  };
};
