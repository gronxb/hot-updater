import { readFile } from "fs/promises";
import path from "path";
import { describe, expect, it } from "vitest";
import { mergePrismaSchema } from "./prisma-schema-merger";

const HOT_UPDATER_MODELS = `model bundles {
  id                  String  @id
  platform            String
  should_force_update Boolean
  enabled             Boolean
  file_hash           String
  git_commit_hash     String?
  message             String?
  channel             String
  storage_uri         String
  target_app_version  String?
  fingerprint_hash    String?
  metadata            Json
}

model private_hot_updater_settings {
  key   String @id
  value String @default("0.21.0")
}`;

describe("prisma-schema-merger", () => {
  describe("mergePrismaSchema", () => {
    it("should add hot-updater models to an empty schema", async () => {
      const emptySchemaPath = path.join(
        __dirname,
        "../__fixtures__/prisma-schema-empty.prisma",
      );
      const emptySchema = await readFile(emptySchemaPath, "utf-8");

      const result = mergePrismaSchema(emptySchema, HOT_UPDATER_MODELS);

      expect(result.hadExistingModels).toBe(false);
      expect(result.content).toContain("generator client");
      expect(result.content).toContain("BEGIN HOT-UPDATER MODELS");
      expect(result.content).toContain("model bundles");
      expect(result.content).toContain("model private_hot_updater_settings");
      expect(result.content).toContain("END HOT-UPDATER MODELS");
    });

    it("should preserve existing user models when adding hot-updater models", async () => {
      const userModelsSchemaPath = path.join(
        __dirname,
        "../__fixtures__/prisma-schema-with-user-models.prisma",
      );
      const userModelsSchema = await readFile(userModelsSchemaPath, "utf-8");

      const result = mergePrismaSchema(userModelsSchema, HOT_UPDATER_MODELS);

      expect(result.hadExistingModels).toBe(false);
      // User models should be preserved
      expect(result.content).toContain("model User");
      expect(result.content).toContain("model Post");
      expect(result.content).toContain("email     String   @unique");
      // Hot-updater models should be added
      expect(result.content).toContain("BEGIN HOT-UPDATER MODELS");
      expect(result.content).toContain("model bundles");
      expect(result.content).toContain("END HOT-UPDATER MODELS");
    });

    it("should update existing hot-updater models", async () => {
      const schemaWithHotUpdaterPath = path.join(
        __dirname,
        "../__fixtures__/prisma-schema-with-hot-updater.prisma",
      );
      const schemaWithHotUpdater = await readFile(
        schemaWithHotUpdaterPath,
        "utf-8",
      );

      const updatedModels = `model bundles {
  id                  String  @id
  platform            String
  should_force_update Boolean
  enabled             Boolean
  file_hash           String
  new_field           String  // New field added
  git_commit_hash     String?
  message             String?
  channel             String
  storage_uri         String
  target_app_version  String?
  fingerprint_hash    String?
  metadata            Json
}

model private_hot_updater_settings {
  key   String @id
  value String @default("0.22.0")
}`;

      const result = mergePrismaSchema(schemaWithHotUpdater, updatedModels);

      expect(result.hadExistingModels).toBe(true);
      // User model should still be preserved
      expect(result.content).toContain("model User");
      // Updated models should be present
      expect(result.content).toContain("new_field");
      expect(result.content).toContain('"0.22.0"');
      // Should only have one set of hot-updater markers
      const beginCount = (
        result.content.match(/BEGIN HOT-UPDATER MODELS/g) || []
      ).length;
      const endCount = (result.content.match(/END HOT-UPDATER MODELS/g) || [])
        .length;
      expect(beginCount).toBe(1);
      expect(endCount).toBe(1);
    });

    it("should be idempotent - running multiple times produces same result", async () => {
      const emptySchemaPath = path.join(
        __dirname,
        "../__fixtures__/prisma-schema-empty.prisma",
      );
      const emptySchema = await readFile(emptySchemaPath, "utf-8");

      const firstRun = mergePrismaSchema(emptySchema, HOT_UPDATER_MODELS);
      const secondRun = mergePrismaSchema(firstRun.content, HOT_UPDATER_MODELS);
      const thirdRun = mergePrismaSchema(secondRun.content, HOT_UPDATER_MODELS);

      expect(firstRun.hadExistingModels).toBe(false);
      expect(secondRun.hadExistingModels).toBe(true);
      expect(thirdRun.hadExistingModels).toBe(true);

      // Content should be stable after first merge
      expect(secondRun.content).toBe(thirdRun.content);

      // Should only have one set of markers
      const beginCount = (
        thirdRun.content.match(/BEGIN HOT-UPDATER MODELS/g) || []
      ).length;
      expect(beginCount).toBe(1);
    });

    it("should handle schemas with comments and whitespace", () => {
      const schemaWithComments = `generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

// This is my custom User model
model User {
  id    String @id
  email String @unique
  // More fields here
  name  String?
}`;

      const result = mergePrismaSchema(schemaWithComments, HOT_UPDATER_MODELS);

      expect(result.content).toContain("// This is my custom User model");
      expect(result.content).toContain("// More fields here");
      expect(result.content).toContain("model User");
      expect(result.content).toContain("BEGIN HOT-UPDATER MODELS");
    });

    it("should handle full schema input from generateSchema (with generator/datasource)", async () => {
      // Simulate what generateSchema() returns - complete schema with generator, datasource, and models
      const fullGeneratedSchema = `generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "sqlite"
  url      = "file:./dev.db"
}

model bundles {
  id                  String  @id
  platform            String
  should_force_update Boolean
  enabled             Boolean
  file_hash           String
  git_commit_hash     String?
  message             String?
  channel             String
  storage_uri         String
  target_app_version  String?
  fingerprint_hash    String?
  metadata            Json
}

model private_hot_updater_settings {
  key   String @id
  value String @default("0.21.0")
}`;

      // Existing schema with User model
      const existingSchemaWithUser = `generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model User {
  id        String   @id @default(uuid())
  email     String   @unique
  name      String?
  createdAt DateTime @default(now())
}`;

      const result = mergePrismaSchema(
        existingSchemaWithUser,
        fullGeneratedSchema,
      );

      // Should preserve existing generator/datasource from existing schema
      expect(result.content).toContain('provider = "postgresql"');
      expect(result.content).toContain('env("DATABASE_URL")');
      // Should preserve User model
      expect(result.content).toContain("model User");
      expect(result.content).toContain("email     String   @unique");
      // Should add hot-updater models (only models, not generator/datasource from generated schema)
      expect(result.content).toContain("model bundles");
      expect(result.content).toContain("model private_hot_updater_settings");
      expect(result.content).toContain("BEGIN HOT-UPDATER MODELS");
      // Should NOT contain the sqlite datasource from generated schema
      expect(result.content).not.toContain('"file:./dev.db"');
    });
  });
});
