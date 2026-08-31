import type { Bundle, ReleaseRow } from "@hot-updater/plugin-core";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { type ReactNode, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ReleaseEditorSheet } from "./ReleaseEditorSheet";

const preflight = vi.fn();
const promote = vi.fn();
const update = vi.fn();

const release = {
  bundle_id: "bundle-1",
  channel_id: "channel-1",
  created_at_ms: 1,
  enabled: true,
  fingerprint_hash: null,
  id: "release-1",
  kind: "BUNDLE",
  message: "Initial message",
  operation: "DEPLOY",
  platform: "ios",
  revision: 2,
  rollout_cohort_count: 1_000,
  scope_key: "scope-1",
  should_force_update: false,
  source_release_id: null,
  strategy: "APP_VERSION",
  target_app_version: "1.2.x",
  target_cohorts: [],
  updated_at_ms: 1,
} as ReleaseRow;

const bundle = {
  fileHash: "bundle-file-hash",
  gitCommitHash: "commit-hash",
  id: "bundle-1",
  platform: "ios",
  storageUri: "s3://updates/bundle-1",
} as Bundle;

let releaseValue = release;

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));

vi.mock("@/components/features/bundles/BundleInsightsSummary", () => ({
  BundleInsightsSummary: () => <div>Activity · 30 days</div>,
}));

vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ children, open }: { children: ReactNode; open: boolean }) =>
    open ? <div>{children}</div> : null,
  SheetContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  SheetDescription: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  SheetHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));

vi.mock("@/components/ui/slider", () => ({
  Slider: () => <div aria-hidden="true" />,
}));

vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));

vi.mock("@/lib/api", () => ({
  useBundleQuery: () => ({
    data: bundle,
    isError: false,
    isPending: false,
  }),
  useDeleteReleaseMutation: () => ({ isPending: false, mutateAsync: vi.fn() }),
  useConfigQuery: () => ({ data: undefined, isFetched: true }),
  usePreflightReleaseMutation: () => ({
    isPending: false,
    mutateAsync: preflight,
  }),
  usePromoteReleaseMutation: () => ({
    isPending: false,
    mutateAsync: promote,
  }),
  useReleaseCatalogDiagnosticsQuery: () => ({ data: null }),
  useReleaseQuery: () => ({ data: releaseValue, isError: false }),
  useUpdateReleaseMutation: () => ({ isPending: false, mutateAsync: update }),
}));

describe("ReleaseEditorSheet", () => {
  afterEach(cleanup);

  beforeEach(() => {
    releaseValue = release;
    preflight.mockReset();
    preflight.mockResolvedValue({});
    promote.mockReset();
    promote.mockResolvedValue({});
    update.mockReset();
    update.mockResolvedValue({});
  });

  it("converts percentage input and preflights before saving", async () => {
    render(
      <ReleaseEditorSheet
        channels={[{ id: "channel-1", name: "production" }]}
        onOpenChange={vi.fn()}
        open
        releaseId={release.id}
      />,
    );

    fireEvent.change(
      screen.getByRole("textbox", { name: "Rollout percentage" }),
      { target: { value: "33.37" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(preflight).toHaveBeenCalledWith({
      expectedRevision: 2,
      patch: expect.objectContaining({ rolloutCohortCount: 333 }),
      releaseId: "release-1",
    });
    expect(preflight.mock.invocationCallOrder[0]).toBeLessThan(
      update.mock.invocationCallOrder[0]!,
    );
  });

  it("closes the sheet only after saving and refreshing queries completes", async () => {
    let finishUpdate!: () => void;
    update.mockReturnValue(
      new Promise<void>((resolve) => {
        finishUpdate = resolve;
      }),
    );
    function Editor() {
      const [open, setOpen] = useState(true);
      return (
        <ReleaseEditorSheet
          channels={[{ id: "channel-1", name: "production" }]}
          onOpenChange={setOpen}
          open={open}
          releaseId={release.id}
        />
      );
    }
    render(<Editor />);

    fireEvent.change(screen.getByLabelText("Message"), {
      target: { value: "Updated message" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(
      screen.getByRole("heading", { name: "Bundle Detail" }),
    ).toBeDefined();

    await act(async () => finishUpdate());

    expect(screen.queryByRole("heading", { name: "Bundle Detail" })).toBeNull();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("keeps Insights, editing, and readable metadata in one familiar detail flow", () => {
    const { container } = render(
      <ReleaseEditorSheet
        channels={[{ id: "channel-1", name: "production" }]}
        onOpenChange={vi.fn()}
        open
        releaseId={release.id}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Bundle Detail" }),
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Promote to channel" }),
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Download bundle" }),
    ).toBeDefined();
    expect(screen.getByText("Activity · 30 days")).toBeDefined();
    expect(screen.getByText("Metadata")).toBeDefined();
    expect(
      screen.getByRole("heading", { name: "Delivery settings" }),
    ).toBeDefined();
    expect(screen.getAllByText("Target app version").length).toBeGreaterThan(0);
    expect(screen.getByText("Bundle hash")).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Remove from channel" }),
    ).toBeDefined();
    expect(screen.getByText("Channel")).toBeDefined();
    expect(screen.getByText("Platform")).toBeDefined();
    expect(screen.queryByText(/deployment/i)).toBeNull();
    expect(screen.queryByText("s3://updates/bundle-1")).toBeNull();
    expect(screen.queryByText("DEPLOY")).toBeNull();
    expect(
      screen.queryByText("Manage delivery settings and actions"),
    ).toBeNull();
    expect(container.textContent!.indexOf("Activity · 30 days")).toBeLessThan(
      container.textContent!.indexOf("Delivery settings"),
    );
    expect(container.textContent!.indexOf("Delivery settings")).toBeLessThan(
      container.textContent!.indexOf("Message"),
    );
    expect(container.textContent!.indexOf("Message")).toBeLessThan(
      container.textContent!.indexOf("Actions"),
    );
    expect(container.textContent!.indexOf("Actions")).toBeLessThan(
      container.textContent!.indexOf("Metadata"),
    );
    expect(screen.queryByRole("heading", { name: "Delivery" })).toBeNull();

    for (const actionName of [
      "Promote to channel",
      "Download bundle",
      "Remove from channel",
    ]) {
      expect(
        screen.getByRole("button", { name: actionName }).className,
      ).toContain("w-full");
    }
  });

  it("restores the main Console cohort preview for gradual rollout", () => {
    releaseValue = { ...release, rollout_cohort_count: 100 };
    render(
      <ReleaseEditorSheet
        channels={[{ id: "channel-1", name: "production" }]}
        onOpenChange={vi.fn()}
        open
        releaseId={release.id}
      />,
    );

    const additionalCohortsLabel = screen.getByText(
      "Additional cohorts (optional)",
    );
    const previewButton = within(
      additionalCohortsLabel.parentElement!,
    ).getByRole("button", { name: "Preview cohorts" });

    fireEvent.click(previewButton);

    expect(screen.getByRole("dialog")).toBeDefined();
    expect(screen.getByText("Selected cohorts")).toBeDefined();
  });

  it("keeps Preview cohorts available at full rollout", () => {
    render(
      <ReleaseEditorSheet
        channels={[{ id: "channel-1", name: "production" }]}
        onOpenChange={vi.fn()}
        open
        releaseId={release.id}
      />,
    );

    const additionalCohortsLabel = screen.getByText(
      "Additional cohorts (optional)",
    );
    const previewButton = within(
      additionalCohortsLabel.parentElement!,
    ).getByRole("button", { name: "Preview cohorts" });

    fireEvent.click(previewButton);

    expect(
      screen.getByRole("list", { name: "Included numeric cohorts" }),
    ).toBeDefined();
  });

  it("keeps the v0 move model and selects the target from a listbox", async () => {
    render(
      <ReleaseEditorSheet
        channels={[
          { id: "channel-1", name: "production" },
          { id: "channel-2", name: "beta" },
        ]}
        onOpenChange={vi.fn()}
        open
        releaseId={release.id}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Promote to channel" }));

    const dialog = screen.getByRole("dialog", {
      name: "Promote to Channel",
    });
    expect(
      within(dialog).getByRole("combobox", { name: "Action" }).textContent,
    ).toContain("Move bundle");
    expect(within(dialog).queryByText("Current channel")).toBeNull();
    expect(
      within(dialog).getByText(
        "Move this Bundle to the target channel. Devices in the current channel may fall back to an earlier Bundle.",
      ),
    ).toBeDefined();

    fireEvent.click(
      within(dialog).getByRole("combobox", { name: "Target Channel" }),
    );
    const betaOption = screen.getByRole("option", { name: "beta" });
    fireEvent.pointerDown(betaOption);
    fireEvent.click(betaOption);
    expect(
      within(dialog).queryByRole("button", {
        name: "Use beta as target channel",
      }),
    ).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Move" }));

    await waitFor(() => {
      expect(promote).toHaveBeenCalledWith({
        action: "move",
        expectedRevision: 2,
        releaseId: "release-1",
        targetChannel: "beta",
      });
    });
  });

  it("maps the v0 copy action to keeping the source Release enabled", async () => {
    render(
      <ReleaseEditorSheet
        channels={[
          { id: "channel-1", name: "production" },
          { id: "channel-2", name: "beta" },
        ]}
        onOpenChange={vi.fn()}
        open
        releaseId={release.id}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Promote to channel" }));
    fireEvent.click(screen.getByRole("combobox", { name: "Action" }));
    const copyOption = await screen.findByRole("option", {
      name: "Copy bundle",
    });
    fireEvent.pointerDown(copyOption);
    fireEvent.click(copyOption);

    const dialog = screen.getByRole("dialog", {
      name: "Promote to Channel",
    });
    expect(
      within(dialog).getByText(
        "Make this Bundle available in the target channel and keep it in the current channel.",
      ),
    ).toBeDefined();
    fireEvent.click(
      within(dialog).getByRole("combobox", { name: "Target Channel" }),
    );
    const betaOption = screen.getByRole("option", { name: "beta" });
    fireEvent.pointerDown(betaOption);
    fireEvent.click(betaOption);
    fireEvent.click(within(dialog).getByRole("button", { name: "Copy" }));

    await waitFor(() => {
      expect(promote).toHaveBeenCalledWith({
        action: "copy",
        expectedRevision: 2,
        releaseId: "release-1",
        targetChannel: "beta",
      });
    });
  });

  it("uses disabling as the only rollback action", async () => {
    render(
      <ReleaseEditorSheet
        channels={[{ id: "channel-1", name: "production" }]}
        onOpenChange={vi.fn()}
        open
        releaseId={release.id}
      />,
    );

    expect(
      screen.getByText(
        "Disabling rolls devices back to the previous enabled Release on their next check, or to the built-in app when none remains.",
      ),
    ).toBeDefined();
    expect(screen.queryByRole("button", { name: /roll back/i })).toBeNull();

    fireEvent.click(screen.getByRole("switch", { name: "Enabled" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(preflight).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRevision: 2,
        patch: expect.objectContaining({ enabled: false }),
        releaseId: "release-1",
      }),
    );
  });

  it.each([
    ["preflight", "Catalog exceeds its size limit"],
    ["update", "Release revision conflict"],
  ])(
    "keeps the sheet open and preserves the draft when %s fails",
    async (stage, message) => {
      const onOpenChange = vi.fn();
      (stage === "preflight" ? preflight : update).mockRejectedValue(
        new Error(message),
      );
      render(
        <ReleaseEditorSheet
          channels={[{ id: "channel-1", name: "production" }]}
          onOpenChange={onOpenChange}
          open
          releaseId={release.id}
        />,
      );

      fireEvent.change(screen.getByLabelText("Message"), {
        target: { value: "Keep this draft" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

      expect(await screen.findByText(message)).not.toBeNull();
      expect(update).toHaveBeenCalledTimes(stage === "preflight" ? 0 : 1);
      expect(onOpenChange).not.toHaveBeenCalled();
      expect(
        (screen.getByLabelText("Message") as HTMLTextAreaElement).value,
      ).toBe("Keep this draft");
    },
  );
});
