// @vitest-environment node

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireConsoleAccess: vi.fn(),
  server: undefined as
    | undefined
    | ((options: { next: () => Promise<unknown> }) => Promise<unknown>),
}));

vi.mock("@tanstack/react-start", () => ({
  createMiddleware: () => ({
    server(server: NonNullable<typeof mocks.server>) {
      mocks.server = server;
      return {};
    },
  }),
}));
vi.mock("@tanstack/react-start/server", () => ({
  getRequest: () => new Request("https://console.example.com/_serverFn/x"),
}));
vi.mock("./server/auth.server", () => ({
  requireConsoleAccess: mocks.requireConsoleAccess,
}));

await import("./console-access");

afterEach(() => vi.resetAllMocks());

/** The sign-in page reads these before anyone is signed in. */
const PUBLIC_SERVER_FUNCTIONS = new Set([
  "getConsoleAccessRpc",
  "getConsoleAuthProvidersRpc",
]);

const sourceFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    return /\.tsx?$/.test(entry.name) && !/\.spec\.tsx?$/.test(entry.name)
      ? [file]
      : [];
  });

/** Every `export const name = createServerFn(...)` and what follows the call. */
const serverFunctions = () =>
  sourceFiles(path.resolve(import.meta.dirname, "..")).flatMap((file) => {
    const source = readFileSync(file, "utf8");
    return [...source.matchAll(/export const (\w+) = createServerFn\(/g)].map(
      (match) => {
        let index = (match.index ?? 0) + match[0].length;
        for (let depth = 1; depth > 0; index += 1) {
          if (source[index] === "(") depth += 1;
          if (source[index] === ")") depth -= 1;
        }
        return {
          name: match[1]!,
          file: path.relative(import.meta.dirname, file),
          chain: source.slice(index).trimStart(),
        };
      },
    );
  });

describe("console access before input", () => {
  it("guards every server function but the sign-in reads", () => {
    const functions = serverFunctions();
    expect(functions.length).toBeGreaterThan(20);
    const unguarded = functions
      .filter(({ name }) => !PUBLIC_SERVER_FUNCTIONS.has(name))
      .filter(({ chain }) => !chain.startsWith(".middleware([consoleAccess"))
      .map(({ name, file }) => `${file}: ${name}`);
    expect(unguarded).toEqual([]);
    expect(
      functions.filter(({ name }) => PUBLIC_SERVER_FUNCTIONS.has(name)),
    ).toHaveLength(PUBLIC_SERVER_FUNCTIONS.size);
  });

  it("refuses an unauthorized caller before the function reads its input", async () => {
    const refusal = new Response("Sign in", { status: 401 });
    mocks.requireConsoleAccess.mockRejectedValue(refusal);
    const next = vi.fn();

    await expect(mocks.server!({ next })).rejects.toBe(refusal);
    expect(next).not.toHaveBeenCalled();
  });

  it("lets an authorized caller through to the function", async () => {
    mocks.requireConsoleAccess.mockResolvedValue({ email: "dev@example.com" });
    const next = vi.fn().mockResolvedValue("handled");

    await expect(mocks.server!({ next })).resolves.toBe("handled");
    expect(mocks.requireConsoleAccess).toHaveBeenCalledOnce();
  });
});
