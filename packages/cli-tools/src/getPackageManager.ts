export const getPackageManager = () => {
  const [packageManagerWithVersion] =
    process.env["npm_config_user_agent"]?.split(" ") ?? [];

  if (!packageManagerWithVersion) {
    return "npm";
  }

  const [packageManager] = packageManagerWithVersion.split("/");
  if (!packageManager) {
    return "npm";
  }

  return packageManager;
};
