import { access, mkdir, readFile, writeFile } from "fs/promises";
import path from "path";

import { p } from "@hot-updater/cli-tools";

import { ui } from "../utils/cli-ui";
import { requestGenerateExit } from "./utils/generate-command-control";
import { mergePrismaSchema } from "./utils/prisma-schema-merger";

interface NodeError extends Error {
  readonly code?: string;
}

function isNodeError(error: unknown): error is NodeError {
  return error instanceof Error && "code" in error;
}

export async function generatePrismaSchema(
  schemaCode: string,
  outputDir: string,
  skipConfirm: boolean,
) {
  const prismaSchemaPath = path.join(outputDir, "prisma", "schema.prisma");
  const schemaExists = await pathExists(prismaSchemaPath);

  let finalContent: string;
  let message: string;

  if (!schemaExists) {
    p.log.warn("Generated schema only contains model definitions.");

    finalContent = schemaCode;
    message = "Create prisma/schema.prisma?";
  } else {
    const existingSchema = await readFile(prismaSchemaPath, "utf-8");
    const { content, hadExistingModels } = mergePrismaSchema(
      existingSchema,
      schemaCode,
    );
    finalContent = content;
    message = hadExistingModels
      ? "Update hot-updater models in prisma/schema.prisma?"
      : "Add hot-updater models to prisma/schema.prisma?";
  }

  if (!skipConfirm) {
    const shouldContinue = await p.confirm({
      message,
      initialValue: true,
    });

    if (p.isCancel(shouldContinue) || !shouldContinue) {
      p.cancel("Operation cancelled");
      requestGenerateExit(0);
    }
  }

  await mkdir(path.dirname(prismaSchemaPath), { recursive: true });

  await writeFile(prismaSchemaPath, finalContent, "utf-8");

  p.log.success(
    ui.line([schemaExists ? "Updated" : "Created", ui.path(prismaSchemaPath)]),
  );
  p.log.message(
    ui.block("Run", [
      ui.kv("Prisma", ui.command("npx prisma generate")),
      ui.kv("Migrate", ui.command("npx prisma migrate dev")),
    ]),
  );
}

async function pathExists(filePath: string) {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
