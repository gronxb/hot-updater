import { beforeEach, describe, expect, it, vi } from "vitest";

import { printAppSetup, renderAppSetup } from "./appSetup";

const prompts = vi.hoisted(() => ({
  note: vi.fn(),
  message: vi.fn(),
}));

vi.mock("./prompts", () => ({
  p: { note: prompts.note, log: { message: prompts.message } },
}));

const credential = {
  label: "API key",
  header: "x-api-key",
  value: 'key"with-quote',
};

describe("renderAppSetup", () => {
  it("sends the credential in its header", () => {
    const source = renderAppSetup({
      baseURL: "https://example.com/hot-updater",
      credential,
    });

    expect(source).toContain('baseURL: "https://example.com/hot-updater",');
    expect(source).toContain(
      '  requestHeaders: {\n    "x-api-key": "key\\"with-quote",\n  },',
    );
    expect(source).toContain("HotUpdater.checkForUpdate");
    expect(source).not.toContain("HotUpdater.wrap");
  });

  it("sends no headers to public client routes", () => {
    const source = renderAppSetup({ baseURL: "https://example.com" });

    expect(source).toContain(
      'HotUpdater.init({\n  baseURL: "https://example.com",\n});',
    );
    expect(source).not.toContain("requestHeaders");
    expect(source).not.toContain("plugins");
  });

  it("imports and adds the client plugins the server's plugins ask for", () => {
    const source = renderAppSetup({
      baseURL: "https://example.com",
      credential,
      clientPlugins: [
        { module: "@hot-updater/react-native", name: "insights" },
        { module: "feedback-rn", name: "feedback" },
      ],
    });

    // A built-in plugin joins HotUpdater's import from the SDK.
    expect(source).toContain(
      [
        'import { HotUpdater, insights } from "@hot-updater/react-native";',
        'import { feedback } from "feedback-rn";',
      ].join("\n"),
    );
    expect(source).toContain(
      '    "x-api-key": "key\\"with-quote",\n  },\n  plugins: [insights(), feedback()],\n});',
    );
  });
});

describe("printAppSetup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("prints the code and the credential", () => {
    printAppSetup({
      baseURL: "https://example.com",
      credential,
      clientPlugins: [],
    });

    expect(prompts.note).toHaveBeenNthCalledWith(
      1,
      renderAppSetup({ baseURL: "https://example.com", credential }),
    );
    expect(prompts.note).toHaveBeenNthCalledWith(
      2,
      credential.value,
      "API key",
    );
    expect(prompts.message).toHaveBeenCalledWith(
      "Store this API key separately in a secure place.",
    );
  });

  it("prints only the credential without a URL, and only the code without a credential", () => {
    printAppSetup({ credential, clientPlugins: [] });
    expect(prompts.note).toHaveBeenCalledOnce();
    expect(prompts.note).toHaveBeenCalledWith(credential.value, "API key");

    vi.clearAllMocks();
    printAppSetup({ baseURL: "https://example.com", clientPlugins: [] });
    expect(prompts.note).toHaveBeenCalledOnce();
    expect(prompts.message).not.toHaveBeenCalled();
  });
});
