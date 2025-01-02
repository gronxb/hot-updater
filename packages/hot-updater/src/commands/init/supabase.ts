import * as p from "@clack/prompts";
import { ExecaError, execa } from "execa";

export const initSupabase = async () => {
  const confirmed = await p.confirm({
    message: "Do you have supabsae organization?",
    initialValue: false,
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
    initialValue: false,
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
};
