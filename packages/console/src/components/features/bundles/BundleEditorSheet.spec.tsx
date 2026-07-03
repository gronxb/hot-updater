import type { Bundle } from "@hot-updater/plugin-core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConsoleApiProvider, type ConsoleApiClient } from "@/lib/api";

import { BundleEditorSheet } from "./BundleEditorSheet";

const mockBundleEditorForm = vi.fn();

vi.mock("./BundleEditorForm", () => ({
  BundleEditorForm: (props: {
    onBusyChange?: (busy: boolean) => void;
    onClose: () => void;
  }) => {
    mockBundleEditorForm(props);

    return (
      <div>
        <button onClick={() => props.onBusyChange?.(true)}>Mark busy</button>
        <button onClick={() => props.onBusyChange?.(false)}>Mark idle</button>
        <button onClick={props.onClose}>Finish save</button>
      </div>
    );
  },
}));

vi.mock("./BundleBasicInfo", () => ({
  BundleBasicInfo: () => <div>Bundle basic info</div>,
}));

vi.mock("./BundleMetadata", () => ({
  BundleMetadata: () => <div>Bundle metadata</div>,
}));

vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({
    open,
    onOpenChange,
    children,
  }: {
    open: boolean;
    onOpenChange?: (open: boolean) => void;
    children: ReactNode;
  }) =>
    open ? (
      <div>
        <button onClick={() => onOpenChange?.(false)}>Dismiss sheet</button>
        {children}
      </div>
    ) : null,
  SheetContent: ({
    children,
    showCloseButton = true,
  }: {
    children: ReactNode;
    showCloseButton?: boolean;
  }) => (
    <div>
      {showCloseButton ? <button>Sheet close</button> : null}
      {children}
    </div>
  ),
  SheetDescription: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  SheetHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/skeleton", () => ({
  Skeleton: () => <div>Skeleton</div>,
}));

class ResizeObserverMock implements ResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

const bundle: Bundle = {
  id: "0195a408-8f13-7d9b-8df4-123456789abc",
  channel: "production",
  platform: "ios",
  enabled: true,
  shouldForceUpdate: false,
  fileHash: "abc123",
  storageUri: "s3://bucket/bundle.zip",
  gitCommitHash: "deadbeef",
  message: "Initial message",
  targetAppVersion: "1.0.0",
  fingerprintHash: null,
  rolloutCohortCount: 1000,
  targetCohorts: [],
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
    getConfig: vi.fn(),
    getConfigLoaded: vi.fn(),
    promoteBundle: vi.fn(),
    updateBundle: vi.fn(),
    ...overrides,
  };
}

function renderBundleEditorSheet({
  api = createConsoleApi(),
  onOpenChange = vi.fn(),
}: {
  api?: ConsoleApiClient;
  onOpenChange?: (open: boolean) => void;
} = {}) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <ConsoleApiProvider client={api}>
        <BundleEditorSheet bundle={bundle} open onOpenChange={onOpenChange} />
      </ConsoleApiProvider>
    </QueryClientProvider>,
  );

  return { queryClient };
}

describe("BundleEditorSheet", () => {
  const mockOnOpenChange = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    mockOnOpenChange.mockReset();
    mockBundleEditorForm.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("ignores dismiss requests while the editor is saving", () => {
    renderBundleEditorSheet({ onOpenChange: mockOnOpenChange });

    fireEvent.click(screen.getByRole("button", { name: "Mark busy" }));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss sheet" }));

    expect(mockOnOpenChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Sheet close" })).toBeNull();
  });

  it("allows successful saves to close the sheet even after entering a busy state", () => {
    renderBundleEditorSheet({ onOpenChange: mockOnOpenChange });

    fireEvent.click(screen.getByRole("button", { name: "Mark busy" }));
    fireEvent.click(screen.getByRole("button", { name: "Finish save" }));

    expect(mockOnOpenChange).toHaveBeenCalledWith(false);
  });

  it("renders provider supplied bundle metrics in the bundle details sheet", async () => {
    renderBundleEditorSheet({
      api: createConsoleApi({
        getBundleMetrics: vi.fn(async () => ({
          active: 7,
          lastSeenAt: "2026-06-28T12:00:00.000Z",
          recovered: 2,
          series: [
            {
              active: 7,
              bucketStart: "2026-06-28T12:00:00.000Z",
              recovered: 2,
            },
          ],
        })),
      }),
    });

    expect(await screen.findByText("Bundle metrics")).toBeTruthy();
    expect(screen.getByText("7 active")).toBeTruthy();
    expect(screen.getByText("2 recovered")).toBeTruthy();
    expect(screen.getByText("Recovery pressure")).toBeTruthy();
  });

  it("renders zero event-sourced metrics for bundles with no app-ready signals", async () => {
    renderBundleEditorSheet({
      api: createConsoleApi({
        getBundleMetrics: vi.fn(async () => ({
          active: 0,
          lastSeenAt: null,
          recovered: 0,
          series: [],
        })),
      }),
    });

    expect(await screen.findByText("Bundle metrics")).toBeTruthy();
    expect(screen.getByText("0 active")).toBeTruthy();
    expect(screen.getByText("0 recovered")).toBeTruthy();
    expect(screen.getByText("No app-ready signals yet")).toBeTruthy();
  });

  it("hides bundle metrics when the provider does not support them", () => {
    renderBundleEditorSheet();

    expect(screen.queryByText("Bundle metrics")).toBeNull();
  });
});
