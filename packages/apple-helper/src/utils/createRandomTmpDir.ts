import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const createRandomTmpDir = async (prefix = "apple-helper-") => {
  return await mkdtemp(join(tmpdir(), prefix));
};
