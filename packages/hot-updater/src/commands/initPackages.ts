export const REQUIRED_PACKAGES = {
  dependencies: ["@hot-updater/react-native"],
  devDependencies: ["dotenv", "react-native-dotenv"],
} as const;

export const PACKAGE_MAP = {
  supabase: {
    dependencies: ["@hot-updater/analytics"],
    devDependencies: ["@hot-updater/supabase"],
  },
  aws: {
    dependencies: [],
    devDependencies: ["@hot-updater/aws"],
  },
  cloudflare: {
    dependencies: ["@hot-updater/analytics"],
    devDependencies: ["wrangler", "@hot-updater/cloudflare"],
  },
  firebase: {
    dependencies: ["@hot-updater/analytics"],
    devDependencies: [
      "firebase-tools",
      "firebase-admin",
      "@hot-updater/firebase",
    ],
  },
} as const;
