import { describe, expect, it } from "vitest";

import workspaceConfig from "../../vitest.workspace";

type WorkspaceProject = {
  readonly test?: {
    readonly name?: string;
    readonly sequence?: { readonly groupOrder?: number };
  };
};

const projects = (
  workspaceConfig as {
    readonly test?: { readonly projects?: readonly WorkspaceProject[] };
  }
).test?.projects;

const project = (name: string): WorkspaceProject | undefined =>
  projects?.find(({ test }) => test?.name === name);

describe("integration project isolation", () => {
  it("finishes Firebase-backed integrations before starting Cloudflare", () => {
    expect(project("integration:default")?.test?.sequence?.groupOrder).toBe(0);
    expect(project("integration:cloudflare")?.test?.sequence?.groupOrder).toBe(
      1,
    );
  });
});
