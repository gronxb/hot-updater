import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DeleteInsightsDataDialog } from "./DeleteInsightsDataDialog";

const { deletion, toastError, toastSuccess } = vi.hoisted(() => ({
  deletion: { isPending: false, mutateAsync: vi.fn() },
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { error: toastError, success: toastSuccess },
}));
vi.mock("@/lib/insights-api", () => ({
  useDeleteInsightsDataMutation: () => deletion,
}));

const open = () => {
  fireEvent.click(screen.getByRole("button", { name: "Delete data" }));
  return screen.getByRole("alertdialog");
};

const confirm = () =>
  fireEvent.click(
    within(screen.getByRole("alertdialog")).getByRole("button", {
      name: "Delete data",
    }),
  );

describe("DeleteInsightsDataDialog", () => {
  beforeEach(() => {
    deletion.mutateAsync.mockReset();
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("deletes the installation's data once confirmed", async () => {
    deletion.mutateAsync.mockResolvedValue({ installations: 1, events: 12 });
    const onDeleted = vi.fn();
    render(
      <DeleteInsightsDataDialog
        installId="install-1"
        userId="user-1"
        onDeleted={onDeleted}
      />,
    );

    const dialog = open();
    expect(dialog.textContent).toContain(
      "Delete this installation's Insights data?",
    );
    expect(dialog.textContent).toContain("hold no identifiers");
    confirm();

    await waitFor(() => expect(onDeleted).toHaveBeenCalledOnce());
    expect(deletion.mutateAsync).toHaveBeenCalledWith({
      installId: "install-1",
    });
    expect(toastSuccess).toHaveBeenCalledWith(
      "Deleted 12 events and 1 latest report",
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("deletes every installation of the user when asked to", async () => {
    deletion.mutateAsync.mockResolvedValue({ installations: 2, events: 1 });
    render(<DeleteInsightsDataDialog installId="install-1" userId="user-1" />);

    open();
    fireEvent.click(
      screen.getByRole("switch", { name: "Every installation of this user" }),
    );
    expect(
      screen.getByRole("alertdialog", {
        name: "Delete the Insights data of user user-1?",
      }),
    ).toBeDefined();
    confirm();

    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith(
        "Deleted 1 event and 2 latest reports",
      ),
    );
    expect(deletion.mutateAsync).toHaveBeenCalledWith({ userId: "user-1" });
  });

  it("offers no user deletion for an installation without a user", () => {
    render(<DeleteInsightsDataDialog installId="install-1" userId={null} />);

    open();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("stays open and says why when the deletion fails", async () => {
    deletion.mutateAsync.mockRejectedValue(
      new Error("Upgrade @hot-updater/server on the server."),
    );
    const onDeleted = vi.fn();
    render(
      <DeleteInsightsDataDialog
        installId="install-1"
        userId={null}
        onDeleted={onDeleted}
      />,
    );

    open();
    confirm();

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "Upgrade @hot-updater/server on the server.",
      ),
    );
    expect(screen.getByRole("alertdialog")).toBeDefined();
    expect(onDeleted).not.toHaveBeenCalled();
  });
});
