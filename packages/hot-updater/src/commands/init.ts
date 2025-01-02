import { isCancel, select } from "@clack/prompts";
import { initSupabase } from "./init/supabase";

export const init = async () => {
  const provider = await select({
    message: "Select a provider",
    options: [{ value: "supabase", label: "Supabase" }],
  });

  if (isCancel(provider)) {
    process.exit(0);
  }
  switch (provider) {
    case "supabase":
      await initSupabase();
      break;
    default:
      throw new Error("Invalid provider");
  }
};
