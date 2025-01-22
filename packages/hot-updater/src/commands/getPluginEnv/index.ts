import { printBanner } from "@/components/banner";
import { isCancel, select } from "@clack/prompts";
import { getSupabaseEnv } from "./getSupabaseEnv";

export const getPluginEnv = async () => {
  printBanner();

  const provider = await select({
    message: "Select a provider",
    options: [{ value: "supabase", label: "Supabase" }],
  });

  if (isCancel(provider)) {
    process.exit(0);
  }

  switch (provider) {
    case "supabase":
      await getSupabaseEnv();
      break;
    default:
      throw new Error("Invalid provider");
  }
};
