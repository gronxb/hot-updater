import path from "path";
import {
  type Config,
  type DeployPlugin,
  getCwd,
  loadConfig,
} from "@hot-updater/plugin-core";
import { findFileWithExtensions } from "@sidecar-app/utils/findFileWithExtensions";
import { initTRPC } from "@trpc/server";
import { z } from "zod";

const t = initTRPC.create();

const router = t.router;
const publicProcedure = t.procedure;

class ConfigManager {
  private _config: Config | null = null;
  private _cwd: string | null = null;

  private _deployPlugin: DeployPlugin | null = null;

  constructor() {
    this._cwd = getCwd();

    this.loadConfig().catch((error) => {
      console.error(error);
    });
  }

  public async loadConfig(): Promise<void> {
    if (!this._cwd) {
      throw new Error("Current working directory not set");
    }
    const configPath = findFileWithExtensions(this._cwd, "hot-updater.config", [
      ".ts",
      ".js",
      ".mts",
      ".cts",
      ".mjs",
      ".cjs",
    ]);
    if (!configPath) {
      throw new Error("Config file not found");
    }

    this._config = await loadConfig();
    this._deployPlugin = this._config?.deploy({ cwd: this._cwd }) ?? null;
  }

  public async getConfig(): Promise<Config | null> {
    return this._config;
  }

  public async setCwd(value: string): Promise<void> {
    this._cwd = value;
    this._config = null;
    await this.loadConfig();
  }

  get isConfigLoaded(): boolean {
    return this._config !== null;
  }

  get deployPlugin(): DeployPlugin | null {
    return this._deployPlugin;
  }

  get cwd(): string | null {
    return this._cwd;
  }
}

const configManager = new ConfigManager();

export const appRouter = router({
  cwd: publicProcedure.query(async () => {
    return configManager.cwd;
  }),
  setCwd: publicProcedure
    .input(z.object({ cwd: z.string() }))
    .mutation(async (opts) => {
      await configManager.setCwd(opts.input.cwd);
      return true;
    }),
  isConfigLoaded: publicProcedure.query(async () => {
    return configManager.isConfigLoaded;
  }),
  updateSources: publicProcedure.query(async () => {
    return configManager.deployPlugin?.getUpdateJson() ?? [];
  }),
});

export type AppRouter = typeof appRouter;
