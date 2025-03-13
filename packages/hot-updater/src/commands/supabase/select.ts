import { delay } from "@/utils/delay";
import * as p from "@clack/prompts";
import type { SupabaseApi } from "@hot-updater/supabase";
import { ExecaError, execa } from "execa";

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
    console.error("Failed to fetch Supabase projects:", err);
    process.exit(1);
  }

  spinner.stop();

  const createProjectOption = `create/${Math.random()
    .toString(36)
    .substring(2, 15)}`;

  const selectedProjectId = await p.select({
    message: "Select a Supabase project",
    options: [
      ...projectsProcess.map((project) => ({
        label: `${project.name} (${project.region})`,
        value: project.id,
      })),
      {
        label: "Create a new project",
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
      });
    } catch (err) {
      if (err instanceof ExecaError) {
        console.error(err.stderr);
      } else {
        console.error(err);
      }
      process.exit(1);
    }

    // Re-run the selection after creating a new project
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
      title: "Fetching bucket list...",
      task: async (message) => {
        while (retryCount < 60 * 5) {
          try {
            if (retryCount === 5) {
              message(
                "Supabase project is not ready yet. This might take a few minutes.",
              );
            }

            buckets = await api.listBuckets();
            return `Retrieved ${buckets.length} buckets`;
          } catch (err) {
            retryCount++;
            await delay(1000);
          }
        }
        p.log.error("Failed to fetch bucket list");
        process.exit(1);
      },
    },
  ]);

  const createBucketOption = `create/${Math.random()
    .toString(36)
    .substring(2, 15)}`;

  const selectedBucketId = await p.select({
    message: "Select a storage bucket",
    options: [
      ...buckets.map((bucket) => ({
        label: bucket.name,
        value: bucket.id,
      })),
      {
        label: "Create a new private bucket",
        value: createBucketOption,
      },
    ],
  });

  if (p.isCancel(selectedBucketId)) {
    process.exit(0);
  }

  if (selectedBucketId === createBucketOption) {
    const bucketName = await p.text({
      message: "Enter a name for the new bucket",
    });

    if (p.isCancel(bucketName)) {
      process.exit(0);
    }

    try {
      await api.createBucket(bucketName, { public: false });
      p.log.success(`Bucket "${bucketName}" created successfully.`);
      const buckets = await api.listBuckets();

      const newBucket = buckets.find((bucket) => bucket.name === bucketName);
      if (!newBucket) {
        throw new Error("Failed to create and select new bucket");
      }
      return newBucket.id;
    } catch (err) {
      p.log.error(`Failed to create new bucket: ${err}`);
      process.exit(1);
    }
  }

  return selectedBucketId;
};
