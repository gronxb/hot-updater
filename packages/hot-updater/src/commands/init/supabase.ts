import * as p from "@clack/prompts";
import { ExecaError, execa } from "execa";

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

  const anonKey = apiKeys.find((key) => key.name === "anon");

  if (!anonKey) {
    throw new Error("Anon key not found");
  }
  console.log(anonKey.api_key);
  //   const supabase = createClient(
  //     "https://ctgmjxoyblmtnvftsotj.supabase.co",
  //     anonKey.api_key,
  //   );
};
