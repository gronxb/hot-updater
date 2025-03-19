import { delay } from "@/utils/delay";
import * as p from "@clack/prompts";
import type { SupabaseApi } from "@hot-updater/supabase";
import { ExecaError, execa } from "execa";

export const selectOrCreateOrganization = async () => {
  const confirmed = await p.confirm({
    message: "Do you already have a Supabase organization?",
    initialValue: true,
  });
  if (p.isCancel(confirmed)) process.exit(0);

  if (confirmed) {
    // If user already has an organization, just return
    return;
  }

  const orgName = await p.text({
    message: "Enter your new Supabase organization name",
  });
  if (p.isCancel(orgName)) process.exit(0);

  try {
    await execa("npx", ["-y", "supabase", "orgs", "create", orgName], {
      stdio: "inherit",
      shell: true,
    });
  } catch (err) {
    if (err instanceof ExecaError && err.stderr) {
      p.log.error(err.stderr);
    } else {
      console.error(err);
    }
    process.exit(1);
  }
};

export const selectProject = async (): Promise<{
  id: string;
  name: string;
  region: string;
}> => {
  const spinner = p.spinner();
  spinner.start("Fetching Supabase projects...");

  let projectsProcess: { id: string; name: string; region: string }[] = [];
  try {
    const listProjects = await execa(
      "npx",
      ["-y", "supabase", "projects", "list", "--output", "json"],
      {},
    );

    projectsProcess =
      listProjects.stdout === "null"
        ? []
        : JSON.parse(listProjects?.stdout ?? "[]");
  } catch (err) {
    spinner.stop();
    console.error("Failed to list Supabase projects:", err);
    process.exit(1);
  }

  spinner.stop();

  const createProjectOption = `create/${Math.random()
    .toString(36)
    .substring(2, 15)}`;

  const selectedProjectId = await p.select({
    message: "Select your Supabase project",
    options: [
      ...projectsProcess.map((project) => ({
        label: `${project.name} (${project.region})`,
        value: project.id,
      })),
      {
        label: "Create new project",
        value: createProjectOption,
      },
    ],
  });

  if (p.isCancel(selectedProjectId)) {
    process.exit(0);
  }

  if (selectedProjectId === createProjectOption) {
    try {
      await execa("npx", ["-y", "supabase", "projects", "create"], {
        stdio: "inherit",
        shell: true,
      });
    } catch (err) {
      if (err instanceof ExecaError) {
        console.error(err.stderr);
      } else {
        console.error(err);
      }
      process.exit(1);
    }

    // Re-run after creating a project to select it
    return selectProject();
  }

  const selectedProject = projectsProcess.find(
    (project) => project.id === selectedProjectId,
  );
  if (!selectedProject) {
    throw new Error("Project not found");
  }

  return selectedProject;
};

export const selectBucket = async (api: SupabaseApi): Promise<string> => {
  let buckets: { id: string; name: string; isPublic: boolean }[] = [];
  let retryCount = 0;

  await p.tasks([
    {
      title: "Fetching buckets...",
      task: async (message) => {
        while (retryCount < 60 * 5) {
          try {
            if (retryCount === 5) {
              message(
                "Supabase project is not ready yet. This may take a few minutes.",
              );
            }

            buckets = await api.listBuckets();
            return `Fetched ${buckets.length} buckets`;
          } catch (err) {
            retryCount++;
            await delay(1000);
          }
        }
        p.log.error("Failed to list buckets");
        process.exit(1);
      },
    },
  ]);

  const publicBuckets = buckets.filter((bucket) => bucket.isPublic);
  const createBucketOption = `create/${Math.random()
    .toString(36)
    .substring(2, 15)}`;

  const selectedBucketId = await p.select({
    message: "Select your storage bucket",
    options: [
      ...publicBuckets.map((bucket) => ({
        label: bucket.name,
        value: bucket.id,
      })),
      {
        label: "Create new public bucket",
        value: createBucketOption,
      },
    ],
  });

  if (p.isCancel(selectedBucketId)) {
    process.exit(0);
  }

  if (selectedBucketId === createBucketOption) {
    const bucketName = await p.text({
      message: "Enter your new bucket name",
    });

    if (p.isCancel(bucketName)) {
      process.exit(0);
    }

    try {
      await api.createBucket(bucketName, { public: true });
      p.log.success(`Bucket "${bucketName}" created successfully.`);
    } catch (err) {
      p.log.error(`Failed to create a new bucket: ${err}`);
      process.exit(1);
    }

    // Re-run selection to pick the newly created bucket
    return selectBucket(api);
  }

  return selectedBucketId;
};
