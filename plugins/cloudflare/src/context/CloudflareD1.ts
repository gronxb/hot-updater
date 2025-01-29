import { type ExecaMethod, execa } from "execa";
import {
  type TransformTemplateArgs,
  transformTemplate,
} from "../utils/transformTemplate";

export class CloudflareD1 {
  private $: ExecaMethod<{
    extendEnv: true;
    env: {
      CLOUDFLARE_API_TOKEN: string;
    };
  }>;

  private name: string;

  constructor({
    name,
    cwd,
    cloudflareApiToken,
  }: { name: string; cwd: string; cloudflareApiToken: string }) {
    this.name = name;
    this.$ = execa({
      extendEnv: true,
      cwd,
      env: {
        CLOUDFLARE_API_TOKEN: cloudflareApiToken,
      },
    });
  }
  async execute<Command extends string, TResult = unknown>(
    command: Command,
    args?: TransformTemplateArgs<Command>,
  ): Promise<{
    results: TResult[];
    success: boolean;
    meta: { duration: number };
  }> {
    const result = await this
      .$`npx -y wrangler d1 execute ${this.name} --command ${transformTemplate(
      command,
      args ?? ({} as TransformTemplateArgs<Command>),
    )} --json --remote`;

    const [data] = JSON.parse(result.stdout ?? "[]") as [
      {
        results: TResult[];
        success: boolean;
        meta: {
          duration: number;
        };
      },
    ];

    return data;
  }
}
