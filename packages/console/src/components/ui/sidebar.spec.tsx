import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Sidebar, SidebarProvider, SidebarTrigger } from "./sidebar";

vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => true }));

describe("Mobile sidebar", () => {
  afterEach(cleanup);

  it("opens outside the layout and dismisses with Escape", async () => {
    const { container } = render(
      <SidebarProvider>
        <Sidebar>
          <a href="/insights">Insights</a>
        </Sidebar>
        <SidebarTrigger />
      </SidebarProvider>,
    );

    const trigger = screen.getByRole("button", { name: "Toggle Sidebar" });
    trigger.focus();
    fireEvent.click(trigger);

    const dialog = await screen.findByRole("dialog", { name: "Sidebar" });
    // The modal must escape any layout clipping or stacking context.
    expect(container.contains(dialog)).toBe(false);
    expect(
      dialog.contains(screen.getByRole("link", { name: "Insights" })),
    ).toBe(true);

    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(document.activeElement).toBe(trigger);
    });
  });

  it("can be closed and reopened using the visible close button", async () => {
    render(
      <SidebarProvider>
        <Sidebar>Navigation</Sidebar>
        <SidebarTrigger />
      </SidebarProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Toggle Sidebar" }));
    fireEvent.click(await screen.findByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Toggle Sidebar" }));
    expect(
      await screen.findByRole("dialog", { name: "Sidebar" }),
    ).toBeDefined();
  });
});
