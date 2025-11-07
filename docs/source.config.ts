import { remarkNpm } from "fumadocs-core/mdx-plugins";
import { defineConfig, defineDocs } from "fumadocs-mdx/config";

export const docs = defineDocs({
  dir: "content/docs",
});

const convert = (cmd: string, pm: string): string => {
  // Convert each line independently to handle multi-line code blocks
  const lines = cmd.split(/\r?\n/);

  const convertLine = (line: string): string => {
    const isInstall = line.includes("install") || line.includes("add");

    if (pm === "npm") return line;

    if (pm === "pnpm") {
      // npx -> pnpm (drop -y/--yes)
      line = line.replace(/^(\s*)npx\s+(?:-y\s+|--yes\s+)?/i, "$1pnpm ");
      if (isInstall) {
        line = line
          .replace("npm install", "pnpm add")
          .replace(" --save-dev", " -D");
      }
      return line;
    }

    if (pm === "yarn") {
      // npx -> yarn (drop -y/--yes)
      line = line.replace(/^(\s*)npx\s+(?:-y\s+|--yes\s+)?/i, "$1yarn ");
      if (isInstall) {
        line = line
          .replace("npm install", "yarn add")
          .replace(" --save-dev", " -D");
      }
      return line;
    }

    return line;
  };

  return lines.map(convertLine).join("\n");
};

export default defineConfig({
  mdxOptions: {
    remarkPlugins: [
      [
        remarkNpm,
        {
          persist: {
            id: "package-manager",
          },
          packageManagers: [
            { command: (cmd: string) => convert(cmd, "npm"), name: "npm" },
            { command: (cmd: string) => convert(cmd, "pnpm"), name: "pnpm" },
            { command: (cmd: string) => convert(cmd, "yarn"), name: "yarn" },
          ],
        },
      ],
    ],
  },
});
