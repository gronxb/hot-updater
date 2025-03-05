import { printBanner } from "@/components/banner";
import { isCancel, select } from "@clack/prompts";
import { initAwsS3LambdaEdge } from "./init/aws";
import { initCloudflareD1R2Worker } from "./init/cloudflareD1R2Worker";

import { initSupabase } from "@/commands/init/supabase";
import { initFirebase } from "./init/firebase";

// const REQUIRED_PACKAGES = {
//   dependencies: ["@hot-updater/react-native"],
//   devDependencies: ["dotenv", "hot-updater"],
// };

// const PACKAGE_MAP = {
//   supabase: {
//     dependencies: [],
//     devDependencies: ["@hot-updater/supabase"],
//   },
//   aws: {
//     dependencies: [],
//     devDependencies: ["@hot-updater/aws"],
//   },
//   "cloudflare-d1-r2-worker": {
//     dependencies: [],
//     devDependencies: ["wrangler", "@hot-updater/cloudflare"],
//   },
//   firebase: {
//     dependencies: [],
//     devDependencies: ["@hot-updater/firebase"],
//   },
// } as const;

export const init = async () => {
  printBanner();

  const buildPluginPackage = await select({
    message: "Select a build plugin",
    options: [
      {
        value: {
          dependencies: [],
          devDependencies: ["@hot-updater/metro"],
        },
        label: "Metro",
      },
    ],
  });

  if (isCancel(buildPluginPackage)) {
    process.exit(0);
  }

  const provider = await select({
    message: "Select a provider",
    options: [
      { value: "supabase", label: "Supabase" },
      {
        value: "cloudflare-d1-r2-worker",
        label: "Cloudflare D1 + R2 + Worker",
      },
      { value: "aws", label: "AWS S3 + Lambda@Edge" },
      { value: "firebase", label: "Firebase" },
    ],
  });

  if (isCancel(provider)) {
    process.exit(0);
  }

  // await ensureInstallPackages({
  //   dependencies: [
  //     ...buildPluginPackage.dependencies,
  //     ...REQUIRED_PACKAGES.dependencies,
  //     ...PACKAGE_MAP[provider].dependencies,
  //   ],
  //   devDependencies: [
  //     ...buildPluginPackage.devDependencies,
  //     ...REQUIRED_PACKAGES.devDependencies,
  //     ...PACKAGE_MAP[provider].devDependencies,
  //   ],
  // });

  switch (provider) {
    case "supabase": {
      await initSupabase();
      break;
    }
    case "cloudflare-d1-r2-worker": {
      await initCloudflareD1R2Worker();
      break;
    }
    case "aws": {
      await initAwsS3LambdaEdge();
      break;
    }
    case "firebase": {
      console.table(await initFirebase());
      break;
    }
    default:
      throw new Error("Invalid provider");
  }
};
