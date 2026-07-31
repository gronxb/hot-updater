import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  link: vi.fn((url: string) => url),
  logStep: vi.fn(),
  text: vi.fn(),
}));

vi.mock("@hot-updater/cli-tools", async () => {
  const actual = await vi.importActual<typeof import("@hot-updater/cli-tools")>(
    "@hot-updater/cli-tools",
  );
  return {
    ...actual,
    link: mocks.link,
    p: {
      ...actual.p,
      log: {
        ...actual.p.log,
        step: mocks.logStep,
      },
      text: mocks.text,
    },
  };
});

import { inputFirebaseApplicationCredentials } from "./firebaseApplicationCredentials";

describe("inputFirebaseApplicationCredentials", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.text.mockResolvedValue("");
  });

  it("opens the selected project's service account settings", async () => {
    await inputFirebaseApplicationCredentials({
      nonInteractive: false,
      projectId: "hot-updater-25989",
    });

    expect(mocks.link).toHaveBeenCalledWith(
      "https://console.firebase.google.com/project/hot-updater-25989/settings/serviceaccounts/adminsdk",
    );
  });

  it("prefills saved credentials while retaining the path placeholder", async () => {
    mocks.text.mockResolvedValue("~/firebase-credentials.json");

    await inputFirebaseApplicationCredentials({
      applicationCredentials: "/saved/firebase-credentials.json",
      nonInteractive: false,
      projectId: "hot-updater-25989",
    });

    expect(mocks.text).toHaveBeenCalledWith(
      expect.objectContaining({
        initialValue: "/saved/firebase-credentials.json",
        placeholder: "~/Downloads/firebase-service-account.json",
      }),
    );
  });
});
