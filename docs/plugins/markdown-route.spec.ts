import { expect, it, vi } from "vitest";

vi.mock("@/lib/source", () => ({
  source: {
    getPages: () => [
      {
        slugs: ["guides", "console-deployment"],
        path: "(latest)/guides/console-deployment/index.mdx",
      },
    ],
    getPage: (slugs: string[]) =>
      slugs.join("/") === "guides/console-deployment"
        ? {
            url: "/docs/guides/console-deployment",
            data: {
              title: "Console hosting",
              getText: async () =>
                "---\ntitle: Console hosting\n---\n## Connect\n\n[Start here](/docs/get-started/introduction)\n",
            },
          }
        : undefined,
  },
}));

import { GET, getConfig } from "../src/pages/api/markdown/[...slugs]";

it("serves canonical and previously published nested index Markdown API routes identically", async () => {
  const canonical = await GET(
    new Request(
      "https://hot-updater.dev/api/markdown/guides/console-deployment.md",
    ),
  );
  const alias = await GET(
    new Request(
      "https://hot-updater.dev/api/markdown/guides/console-deployment/index.md",
    ),
  );
  expect(canonical.status).toBe(200);
  expect(alias.status).toBe(200);
  expect(await alias.text()).toBe(await canonical.text());
  expect((await getConfig()).staticPaths).toEqual([
    ["guides", "console-deployment.md"],
    ["guides", "console-deployment", "index.md"],
  ]);
  expect(
    (
      await GET(
        new Request("https://hot-updater.dev/api/markdown/missing/index.md"),
      )
    ).status,
  ).toBe(404);
});
