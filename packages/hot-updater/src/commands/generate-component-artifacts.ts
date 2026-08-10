import path from "node:path";

import {
  p,
  planDeploymentArtifacts,
  writeDeploymentArtifacts,
} from "@hot-updater/cli-tools";
import { generateUniversalComponentArtifacts } from "@hot-updater/server/db";

import { ui } from "../utils/cli-ui";
import { requestGenerateExit } from "./utils/generate-command-control";
import type { LoadHotUpdaterResult } from "./utils/load-hot-updater";

export const generateComponentArtifacts = async ({
  absoluteOutputDir,
  artifacts,
  reservedOutputPaths = [],
  skipConfirm,
}: {
  readonly absoluteOutputDir: string;
  readonly artifacts: ReturnType<typeof getComponentArtifacts>;
  readonly reservedOutputPaths?: readonly string[];
  readonly skipConfirm: boolean;
}): Promise<void> => {
  if (artifacts.length === 0) return;

  const reserved = new Set(
    reservedOutputPaths.map((outputPath) => outputPath.toLowerCase()),
  );
  for (const artifact of artifacts) {
    const outputPath = path.resolve(absoluteOutputDir, artifact.path);
    if (reserved.has(outputPath.toLowerCase())) {
      throw new Error(
        `Component artifact collides with generated database output: ${artifact.path}`,
      );
    }
  }

  if (!skipConfirm) {
    const shouldContinue = await p.confirm({
      message: `Generate ${artifacts.length} component artifact${artifacts.length === 1 ? "" : "s"}?`,
      initialValue: true,
    });
    if (p.isCancel(shouldContinue) || !shouldContinue) {
      p.cancel("Operation cancelled");
      requestGenerateExit(0);
    }
  }

  const results = await writeDeploymentArtifacts({
    artifacts,
    outputDir: absoluteOutputDir,
  });
  for (const result of results) {
    if (result.status === "written") {
      p.log.success(ui.line(["Created", ui.path(result.path)]));
    }
  }
};

export const getComponentArtifacts = (
  hotUpdater: LoadHotUpdaterResult["hotUpdater"],
) => planDeploymentArtifacts(generateUniversalComponentArtifacts(hotUpdater));
