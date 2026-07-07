import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildManifest,
  consoleTemplateDir,
  mirrorConsoleTemplate,
  repoRoot,
} from "./mirror-console-template.mjs";

const forbiddenPatterns = [
  {
    pattern: /@hot-updater\/console\/(?:hosted|server)/,
    reason: "hosted console package subpath",
  },
  {
    pattern: /@hot-updater\/mock/,
    reason: "demo mock provider",
  },
  {
    pattern: /workspace:\*/,
    reason: "workspace-only dependency range",
  },
  {
    pattern: /catalog:/,
    reason: "workspace catalog dependency range",
  },
  {
    pattern: /gronxb-macmini/,
    reason: "developer-local host allowlist",
  },
];

const textExtensions = new Set([
  ".css",
  ".json",
  ".md",
  ".mjs",
  ".ts",
  ".tsx",
  ".txt",
  ".yml",
  ".yaml",
]);

const isTextFile = (file) => {
  if (file.startsWith(".") && !file.includes("/")) {
    return true;
  }

  return textExtensions.has(path.extname(file));
};

const scanForForbiddenPatterns = async (files) => {
  const violations = [];

  for (const file of files.filter(isTextFile)) {
    const absolutePath = path.join(consoleTemplateDir, file);
    const text = await readFile(absolutePath, "utf8");

    for (const { pattern, reason } of forbiddenPatterns) {
      if (pattern.test(text)) {
        violations.push(`${file}: ${reason}`);
      }
    }
  }

  return violations;
};

const run = async () => {
  const tempRoot = await mkdtemp(
    path.join(os.tmpdir(), "hot-updater-console-template-"),
  );
  const targetDir = path.join(tempRoot, "mirror");

  try {
    const result = await mirrorConsoleTemplate({
      clean: true,
      targetDir,
    });
    const sourceManifest = await buildManifest(consoleTemplateDir);
    const violations = await scanForForbiddenPatterns(Object.keys(sourceManifest));

    if (result.mismatches.length > 0 || violations.length > 0) {
      const details = [
        ...result.mismatches.map((file) => `drift: ${file}`),
        ...violations,
      ].join("\n");
      throw new Error(`Console template check failed:\n${details}`);
    }

    console.log(
      `Console template check passed: ${result.fileCount} files mirror cleanly.`,
    );
    console.log(`Template source: ${path.relative(repoRoot, consoleTemplateDir)}`);
  } finally {
    await rm(tempRoot, { force: true, recursive: true });
  }
};

await run();
