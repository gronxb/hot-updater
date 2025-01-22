import * as p from "@clack/prompts";
import { execa } from "execa";
import { parseR2Output } from "./parseR2Output";

const d1 = async (command: "list" | "create", ...args: string[]) => {
  const { stdout } = await execa(
    "npx",
    ["-y", "wrangler", "d1", command, "--json"],
    {},
  );
  if (!stdout) {
    throw new Error(`Failed to run 'wrangler ${args}'`);
  }
  return JSON.parse(stdout);
};

/**
 * 
 * 
 ❯ npx wrangler r2 bucket list

 ⛅️ wrangler 3.103.2
--------------------

Listing buckets...
name:           bundle
creation_date:  2025-01-21T15:55:24.480Z
 */
const r2Bucket = async (command: "list" | "create", ...args: string[]) => {
  const { stdout } = await execa(
    "npx",
    ["-y", "wrangler", "r2", "bucket", command],
    {},
  );
  if (!stdout) {
    throw new Error(`Failed to run 'wrangler ${args}'`);
  }

  return parseR2Output(stdout);
};

export const initCloudflareD1R2Worker = async () => {
  p.tasks([
    {
      title: "Checking D1 List...",
      task: async () => {
        const d1List = await d1("list");
        p.log.info(`D1 List: ${JSON.stringify(d1List, null, 2)}`);
      },
    },
    {
      title: "Checking R2 List...",
      task: async () => {
        const r2List = await r2Bucket("list");
        p.log.info(`R2 List: ${JSON.stringify(r2List, null, 2)}`);
      },
    },
  ]);
};
