import * as p from "@clack/prompts";
import { execa } from "execa";
import { parseR2Output } from "./parseR2Output";

const cloudflareApi = {
  getR2List: async () => {
    const { stdout } = await execa(
      "npx",
      ["-y", "wrangler", "r2", "bucket", "list"],
      {},
    );
    if (!stdout) {
      throw new Error(`Failed to run 'wrangler r2 bucket list'`);
    }

    return parseR2Output(stdout);
  },
  createR2Bucket: async (bucketName: string) => {
    const { stdout } = await execa(
      "npx",
      ["-y", "wrangler", "r2", "bucket", "create", bucketName],
      {},
    );
    if (!stdout) {
      throw new Error(
        `Failed to run 'wrangler r2 bucket create ${bucketName}'`,
      );
    }

    return true;
  },
  getD1List: async () => {
    const { stdout } = await execa(
      "npx",
      ["-y", "wrangler", "d1", "list", "--json"],
      {},
    );
    return JSON.parse(stdout) as {
      uuid: string;
      name: string;
      created_at: string;
      version: string;
      num_tables: number | null;
      file_size: number | null;
    }[];
  },
  createD1Database: async (databaseName: string) => {
    const { stdout } = await execa(
      "npx",
      ["-y", "wrangler", "d1", "create", databaseName],
      {},
    );
    return stdout;
  },
};

export const initCloudflareD1R2Worker = async () => {
  const s = p.spinner();
  const createKey = `create/${Math.random().toString(36).substring(2, 15)}`;

  s.start("Checking R2 List...");
  const r2List = await cloudflareApi.getR2List();
  s.stop();

  const selectedR2 = await p.select({
    message: "R2 List",
    options: [
      ...r2List.map((r2) => ({
        value: r2.name,
        label: r2.name,
      })),
      {
        value: createKey,
        label: "Create New R2 Bucket",
      },
    ],
  });

  if (p.isCancel(selectedR2)) {
    process.exit(1);
  }

  if (selectedR2 === createKey) {
    const name = await p.text({
      message: "Enter the name of the new R2 Bucket",
    });
    if (p.isCancel(name)) {
      process.exit(1);
    }
    const newR2 = await cloudflareApi.createR2Bucket(name);
    p.log.info(`Created new R2 Bucket: ${newR2}`);
  } else {
    p.log.info(`Selected R2: ${selectedR2}`);
  }

  s.start("Checking D1 List...");
  const d1List = await cloudflareApi.getD1List();
  s.stop();

  const selectedD1 = await p.select({
    message: "D1 List",
    options: [
      ...d1List.map((d1) => ({
        value: d1.name,
        label: d1.name,
      })),
      {
        value: createKey,
        label: "Create New D1 Database",
      },
    ],
  });

  if (p.isCancel(selectedD1)) {
    process.exit(1);
  }

  if (selectedD1 === createKey) {
    const name = await p.text({
      message: "Enter the name of the new D1 Database",
    });
    if (p.isCancel(name)) {
      process.exit(1);
    }
    const newD1 = await cloudflareApi.createD1Database(name);
    p.log.info(`Created new D1 Database: ${newD1}`);
  } else {
    p.log.info(`Selected D1: ${selectedD1}`);
  }
};
