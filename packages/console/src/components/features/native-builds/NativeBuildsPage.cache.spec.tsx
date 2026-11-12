import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getChannels, getNativeBuilds } from "@/lib/api-rpc";

import { NativeBuildsPage } from "./NativeBuildsPage";

// The real query hooks over a real cache; only the server functions are fake.
vi.mock("@/lib/api-rpc", () => ({
  getChannels: vi.fn(),
  getConfig: vi.fn(() => Promise.resolve({ console: {} })),
  getNativeBuildFold: vi.fn(),
  getNativeBuilds: vi.fn(),
}));
vi.mock("@/components/ui/sidebar", () => ({
  SidebarTrigger: () => null,
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  useNavigate: () => vi.fn(),
}));

const listReads = () => vi.mocked(getNativeBuilds).mock.calls.length;

describe("NativeBuildsPage over a cached every-channel page", () => {
  let queryClient: QueryClient;
  const page = (search: Parameters<typeof NativeBuildsPage>[0]["search"]) => (
    <QueryClientProvider client={queryClient}>
      <NativeBuildsPage onSearchChange={vi.fn()} search={search} />
    </QueryClientProvider>
  );

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    vi.mocked(getNativeBuilds).mockResolvedValue({ entries: [] } as never);
  });
  afterEach(() => {
    cleanup();
    queryClient.clear();
    vi.clearAllMocks();
  });

  it("refreshes nothing on the default URL while the channel list fails", async () => {
    vi.mocked(getChannels).mockRejectedValue(new Error("Offline"));
    const view = render(page({ channels: "all" }));
    await waitFor(() => expect(listReads()).toBe(1));
    await screen.findByText("No native builds");

    // Back to the list's default URL, as the Builds tab links.
    view.rerender(page({}));
    await screen.findByText("Channels couldn't be loaded");
    const refresh = screen.getByRole("button", {
      name: "Refresh native builds",
    });
    expect(refresh.hasAttribute("disabled")).toBe(true);
    fireEvent.click(refresh);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(listReads()).toBe(1);
  });

  it("shows no cached every-channel page while the channel list loads", async () => {
    vi.mocked(getChannels).mockResolvedValueOnce([
      { id: "channel:production", name: "production" },
    ] as never);
    const view = render(page({ channels: "all" }));
    await screen.findByText("No native builds");

    // The channel list is read again and has not answered yet.
    vi.mocked(getChannels).mockReturnValue(new Promise(() => {}));
    queryClient.removeQueries({ queryKey: ["channels"] });
    view.rerender(page({}));

    expect(await screen.findByText("Loading native builds")).toBeTruthy();
    expect(screen.queryByText("No native builds")).toBeNull();
    expect(
      screen
        .getByRole("button", { name: "Refresh native builds" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(listReads()).toBe(1);
  });
});
