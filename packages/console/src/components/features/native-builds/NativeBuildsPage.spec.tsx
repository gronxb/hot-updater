import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NativeBuildsPage } from "./NativeBuildsPage";

vi.mock("@/lib/api", () => ({
  useChannelsQuery: () => ({
    data: [
      { id: "channel:all", name: "all" },
      { id: "channel:pr-130", name: "pr-130" },
    ],
    refetch: vi.fn(),
  }),
  useConfigQuery: () => ({ data: { console: {} } }),
  useNativeBuildsQuery: () => ({
    data: { data: [] },
    isError: false,
    isLoading: false,
    isPlaceholderData: false,
    refetch: vi.fn(),
  }),
}));
vi.mock("@/components/ui/sidebar", () => ({
  SidebarTrigger: () => null,
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  useNavigate: () => vi.fn(),
}));

afterEach(cleanup);

const choose = async (option: string) => {
  fireEvent.click(screen.getByRole("combobox", { name: "Channel" }));
  const item = await screen.findByRole("option", { name: option });
  fireEvent.pointerDown(item);
  fireEvent.click(item);
};

describe("NativeBuildsPage", () => {
  it("filters by a channel named all, apart from all channels", async () => {
    const onSearchChange = vi.fn();
    render(<NativeBuildsPage onSearchChange={onSearchChange} search={{}} />);

    await choose("all");
    expect(onSearchChange).toHaveBeenLastCalledWith({ channel: "all" });
  });

  it("clears the filter with All channels, and shows a channel named all as chosen", async () => {
    const onSearchChange = vi.fn();
    render(
      <NativeBuildsPage
        onSearchChange={onSearchChange}
        search={{ channel: "all" }}
      />,
    );

    const trigger = screen.getByRole("combobox", { name: "Channel" });
    expect(trigger.textContent).toContain("all");
    expect(trigger.textContent).not.toContain("All channels");
    await choose("All channels");
    expect(onSearchChange).toHaveBeenLastCalledWith({});
  });
});
