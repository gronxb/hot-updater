import * as p from "@clack/prompts";
import { type SupabaseClient, createClient } from "@supabase/supabase-js";
import { ExecaError, execa } from "execa";

const selectBucket = async (supabase: SupabaseClient) => {
  const publicBuckets = (
    (await supabase.storage.listBuckets()).data ?? []
  ).filter((bucket) => bucket.public);

  const identityCreate = `create/${Math.random().toString(36).substring(2, 15)}`;
  const selectedStorageId = await p.select({
    message: "Select your storage",
    options: [
      ...publicBuckets.map((bucket) => ({
        label: bucket.name,
        value: bucket.id,
      })),
      {
        label: "Create new public bucket",
        value: identityCreate,
      },
    ],
  });

  if (p.isCancel(selectedStorageId)) {
    process.exit(0);
  }

  if (selectedStorageId === identityCreate) {
    const bucketName = await p.text({
      message: "Enter your bucket name",
    });
    if (p.isCancel(bucketName)) {
      process.exit(0);
    }

    await supabase.storage.createBucket(bucketName, {
      public: true,
    });
    return null;
  }
  return selectedStorageId;
};

export const initSupabase = async () => {
  const spinner = p.spinner();
  const confirmed = await p.confirm({
    message: "Do you have supabsae organization?",
    initialValue: true,
  });

  if (p.isCancel(confirmed)) {
    process.exit(0);
  }
  if (!confirmed) {
    const orgName = await p.text({
      message: "Enter your supabase organization name",
    });
    if (p.isCancel(orgName)) {
      process.exit(0);
    }

    try {
      await execa("npx", ["-y", "supabase", "orgs", "create", orgName], {
        stdio: "inherit",
      });
    } catch (err) {
      if (err instanceof ExecaError) {
        console.log(err.stderr);
        process.exit(1);
      }
      console.error(err);
      process.exit(1);
    }
  }

  const projectConfirmed = await p.confirm({
    message: "Do you have supabsae project?",
    initialValue: true,
  });

  if (p.isCancel(projectConfirmed)) {
    process.exit(0);
  }

  if (!projectConfirmed) {
    try {
      await execa("npx", ["-y", "supabase", "projects", "create"], {
        stdio: "inherit",
      });
    } catch (err) {
      if (err instanceof ExecaError) {
        console.log(err.stderr);
      }
      console.error(err);
      process.exit(1);
    }
  }

  spinner.start("Getting projects");
  const listProjects = await execa("npx", [
    "-y",
    "supabase",
    "projects",
    "list",
    "--output",
    "json",
  ]);
  const projectsProcess = JSON.parse(listProjects.stdout ?? "[]") as {
    created_at: string;
    database: {
      host: string;
      postgres_engine: string;
      release_channel: string;
      version: string;
    };
    id: string;
    name: string;
    organization_id: string;
    region: string;
    status: string;
    linked: boolean;
  }[];

  spinner.stop();

  const selectedProjectId = await p.select({
    message: "Select your project",
    options: projectsProcess.map((p) => ({
      label: `${p.name} (${p.region})`,
      value: p.id,
    })),
  });
  if (p.isCancel(selectedProjectId)) {
    process.exit(0);
  }

  const project = projectsProcess.find((p) => p.id === selectedProjectId);
  if (!project) {
    throw new Error("Project not found");
  }

  spinner.start(`Getting api keys (${project?.name})`);
  const apisKeysProcess = await execa("npx", [
    "-y",
    "supabase",
    "projects",
    "api-keys",
    "--project-ref",
    selectedProjectId,
    "--output",
    "json",
  ]);
  spinner.stop();

  const apiKeys = JSON.parse(apisKeysProcess.stdout ?? "[]") as {
    api_key: string;
    name: string;
  }[];

  const serviceRoleKey = apiKeys.find((key) => key.name === "service_role");

  if (!serviceRoleKey) {
    throw new Error("Service role key not found");
  }

  const supabase = createClient(
    `https://${project.id}.supabase.co`,
    serviceRoleKey.api_key,
  );

  let selectedStorageId: string | null = null;
  do {
    selectedStorageId = await selectBucket(supabase);
  } while (!selectedStorageId);

  console.log(selectedStorageId);
};
