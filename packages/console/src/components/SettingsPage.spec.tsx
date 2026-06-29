import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ConsoleApiProvider,
  type ConsoleApiClient,
  type ConsoleConfigResult,
} from "@/lib/api";

import { SettingsPage } from "./SettingsPage";

const { mockToastError, mockToastSuccess } = vi.hoisted(() => ({
  mockToastError: vi.fn(),
  mockToastSuccess: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: {
    error: mockToastError,
    success: mockToastSuccess,
  },
}));

const supportedConfig: ConsoleConfigResult = {
  capabilities: {
    telemetry: true,
    telemetryKey: true,
  },
  console: {},
};

const unsupportedConfig: ConsoleConfigResult = {
  capabilities: {
    telemetry: true,
    telemetryKey: false,
  },
  console: {},
};

function createConsoleApi(
  overrides: Partial<ConsoleApiClient> = {},
): ConsoleApiClient {
  return {
    createBundle: vi.fn(),
    deleteBundle: vi.fn(),
    getBundle: vi.fn(),
    getBundleChildCounts: vi.fn(),
    getBundleChildren: vi.fn(),
    getBundleDownloadUrl: vi.fn(),
    getBundles: vi.fn(),
    getChannels: vi.fn(),
    getConfig: vi.fn(async () => supportedConfig),
    getConfigLoaded: vi.fn(),
    promoteBundle: vi.fn(),
    updateBundle: vi.fn(),
    ...overrides,
  };
}

function renderSettingsPage(api: ConsoleApiClient) {
  const queryClient = new QueryClient({
    defaultOptions: {
      mutations: {
        retry: false,
      },
      queries: {
        retry: false,
      },
    },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <ConsoleApiProvider client={api}>
        <SettingsPage />
      </ConsoleApiProvider>
    </QueryClientProvider>,
  );

  return { queryClient };
}

describe("SettingsPage", () => {
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    writeText = vi.fn(async () => undefined);
    Object.assign(navigator, {
      clipboard: {
        writeText,
      },
    });
    mockToastError.mockReset();
    mockToastSuccess.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("hides Telemetry key controls when the provider is unsupported", async () => {
    renderSettingsPage(
      createConsoleApi({
        getConfig: vi.fn(async () => unsupportedConfig),
      }),
    );

    expect(await screen.findByText("Telemetry key not available")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Issue Telemetry key" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Rotate Telemetry key" }),
    ).toBeNull();
  });

  it("shows only the Telemetry key suffix when plaintext is absent", async () => {
    renderSettingsPage(
      createConsoleApi({
        getTelemetryKeyState: vi.fn(async () => ({
          telemetryKeySuffix: "abcd1234",
        })),
        issueTelemetryKey: vi.fn(),
        rotateTelemetryKey: vi.fn(),
      }),
    );

    expect(await screen.findByText("...abcd1234")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
  });

  it("copies plaintext only for a freshly issued Telemetry key", async () => {
    const api = createConsoleApi({
      getTelemetryKeyState: vi.fn(async () => null),
      issueTelemetryKey: vi.fn(async () => ({
        telemetryKey: "hutk_plaintext",
        telemetryKeySuffix: "aintext",
      })),
      rotateTelemetryKey: vi.fn(),
    });

    renderSettingsPage(api);

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Issue Telemetry key",
      }),
    );

    expect(await screen.findByText("hutk_plaintext")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("hutk_plaintext");
    });

    cleanup();

    renderSettingsPage(
      createConsoleApi({
        getTelemetryKeyState: vi.fn(async () => ({
          telemetryKeySuffix: "aintext",
        })),
        issueTelemetryKey: vi.fn(),
        rotateTelemetryKey: vi.fn(),
      }),
    );

    expect(await screen.findByText("...aintext")).toBeTruthy();
    expect(screen.queryByText("hutk_plaintext")).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
  });

  it("clears freshly issued plaintext after Telemetry key state refreshes", async () => {
    let telemetryKeyState: { readonly telemetryKeySuffix: string } | null =
      null;
    const api = createConsoleApi({
      getTelemetryKeyState: vi.fn(async () => telemetryKeyState),
      issueTelemetryKey: vi.fn(async () => {
        telemetryKeyState = { telemetryKeySuffix: "aintext" };
        return {
          telemetryKey: "hutk_plaintext",
          telemetryKeySuffix: "aintext",
        };
      }),
      rotateTelemetryKey: vi.fn(),
    });

    renderSettingsPage(api);

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Issue Telemetry key",
      }),
    );

    expect(await screen.findByText("hutk_plaintext")).toBeTruthy();

    await waitFor(() => {
      expect(api.getTelemetryKeyState).toHaveBeenCalledTimes(2);
    });

    await waitFor(() => {
      expect(screen.queryByText("hutk_plaintext")).toBeNull();
    });
    expect(screen.getByText("...aintext")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
  });
});
