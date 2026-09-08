import { once } from "node:events";
import fs from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { type AddressInfo, createServer } from "node:net";
import os from "node:os";
import path from "node:path";

import { execa } from "execa";
import { describe, expect, it } from "vitest";

const cliPath = path.resolve(__dirname, "../dist/index.mjs");

describe("CLI console", () => {
  it.each(["HTTP", "TCP"])(
    "reports an occupied port and exits when a %s server is already listening",
    async (protocol) => {
      const server =
        protocol === "HTTP"
          ? createHttpServer((_request, response) => {
              response.end("Existing server");
            })
          : createServer((socket) => socket.destroy());
      const cwd = fs.mkdtempSync(
        path.join(os.tmpdir(), "hot-updater-console-"),
      );

      try {
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const { port } = server.address() as AddressInfo;

        fs.writeFileSync(path.join(cwd, "package.json"), '{"private":true}');
        fs.writeFileSync(
          path.join(cwd, "hot-updater.config.mjs"),
          `export default { console: { port: ${port} } };`,
        );

        const result = await execa(process.execPath, [cliPath, "console"], {
          cwd,
          timeout: 10_000,
          reject: false,
          env: { NO_COLOR: "1", FORCE_COLOR: "0" },
        });
        const output = result.stdout + result.stderr;

        expect(result.timedOut).toBe(false);
        expect(result.exitCode).toBe(1);
        expect(output).toContain(`Port ${port} is already in use.`);
        expect(output).not.toContain("EADDRINUSE");
        expect(output).not.toContain("Console server exited");
        expect(server.listening).toBe(true);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    },
  );
});
