import type { VaultSecret, VaultToken } from "@hot-updater/server/plugins";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SecretsCard } from "./SecretsCard";
import { TokensCard } from "./TokensCard";

const {
  putMutation,
  removeMutation,
  issueMutation,
  revokeMutation,
  toastError,
  toastSuccess,
} = vi.hoisted(() => ({
  putMutation: { isPending: false, mutateAsync: vi.fn() },
  removeMutation: { isPending: false, mutateAsync: vi.fn() },
  issueMutation: { isPending: false, mutateAsync: vi.fn() },
  revokeMutation: { isPending: false, mutateAsync: vi.fn() },
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { error: toastError, success: toastSuccess },
}));

vi.mock("@/lib/vault-api", () => ({
  usePutVaultSecretMutation: () => putMutation,
  useRemoveVaultSecretMutation: () => removeMutation,
  useIssueVaultTokenMutation: () => issueMutation,
  useRevokeVaultTokenMutation: () => revokeMutation,
}));

vi.mock("@/components/ui/dialog", async () => {
  const React = await import("react");
  const Context = React.createContext<{
    onOpenChange?: (open: boolean) => void;
    open: boolean;
  }>({ open: false });
  const Wrapper = ({ children }: { children: ReactNode }) => <>{children}</>;
  return {
    Dialog: ({
      children,
      onOpenChange,
      open,
    }: {
      children: ReactNode;
      onOpenChange?: (open: boolean) => void;
      open: boolean;
    }) =>
      open ? (
        <Context.Provider value={{ onOpenChange, open }}>
          <div role="dialog">{children}</div>
        </Context.Provider>
      ) : null,
    DialogContent: Wrapper,
    DialogDescription: ({ children }: { children: ReactNode }) => (
      <p>{children}</p>
    ),
    DialogFooter: Wrapper,
    DialogHeader: Wrapper,
    DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  };
});

vi.mock("@/components/ui/alert-dialog", async () => {
  const React = await import("react");
  const Context = React.createContext<{
    onOpenChange?: (open: boolean) => void;
    open: boolean;
  }>({ open: false });
  const Wrapper = ({ children }: { children: ReactNode }) => <>{children}</>;
  return {
    AlertDialog: ({
      children,
      onOpenChange,
      open,
    }: {
      children: ReactNode;
      onOpenChange?: (open: boolean) => void;
      open: boolean;
    }) => (
      <Context.Provider value={{ onOpenChange, open }}>
        {children}
      </Context.Provider>
    ),
    AlertDialogAction: ({
      children,
      disabled,
      onClick,
    }: {
      children: ReactNode;
      disabled?: boolean;
      onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
    }) => (
      <button disabled={disabled} onClick={onClick}>
        {children}
      </button>
    ),
    AlertDialogCancel: ({
      children,
      disabled,
    }: {
      children: ReactNode;
      disabled?: boolean;
    }) => <button disabled={disabled}>{children}</button>,
    AlertDialogContent: ({ children }: { children: ReactNode }) => {
      const { open } = React.useContext(Context);
      return open ? <div role="alertdialog">{children}</div> : null;
    },
    AlertDialogDescription: ({ children }: { children: ReactNode }) => (
      <p>{children}</p>
    ),
    AlertDialogFooter: Wrapper,
    AlertDialogHeader: Wrapper,
    AlertDialogMedia: Wrapper,
    AlertDialogTitle: ({ children }: { children: ReactNode }) => (
      <h2>{children}</h2>
    ),
    AlertDialogTrigger: ({
      children,
      render,
    }: {
      children: ReactNode;
      render?: ReactNode;
    }) => {
      const { onOpenChange } = React.useContext(Context);
      if (!React.isValidElement(render)) return null;
      return React.cloneElement(
        render as React.ReactElement<{
          children?: ReactNode;
          onClick?: () => void;
        }>,
        { children, onClick: () => onOpenChange?.(true) },
      );
    },
  };
});

const keystore: VaultSecret = {
  id: `sec-${"a".repeat(22)}`,
  name: "release-keystore",
  kind: "android-keystore",
  version: 3,
  metadata: { keyAlias: "upload" },
  createdAtMs: 1_790_000_000_000,
  updatedAtMs: 1_790_000_000_000,
};

const loaded = <T,>(data: readonly T[]) => ({
  data,
  isError: false,
  isLoading: false,
  refetch: vi.fn(),
});

const base64 = (text: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(text)));

const P8 = "-----BEGIN PRIVATE KEY-----\nMIGT\n-----END PRIVATE KEY-----\n";

beforeEach(() => {
  for (const mutation of [
    putMutation,
    removeMutation,
    issueMutation,
    revokeMutation,
  ]) {
    mutation.isPending = false;
    mutation.mutateAsync.mockReset();
  }
  toastError.mockReset();
  toastSuccess.mockReset();
});

afterEach(cleanup);

describe("SecretsCard", () => {
  it("lists a secret's metadata and never a value", () => {
    render(
      <SecretsCard secrets={loaded([keystore])} status={{ locked: false }} />,
    );
    const row = screen.getByRole("row", { name: /release-keystore/ });

    expect(within(row).getByText("Android keystore")).toBeDefined();
    expect(within(row).getAllByText(/Alias upload/).length).toBeGreaterThan(0);
    expect(within(row).getByText("3")).toBeDefined();
    expect(
      screen.queryByRole("button", { name: /reveal|copy value/i }),
    ).toBeNull();
  });

  it("shows the locked state and offers no write while the console has no master key", () => {
    render(
      <SecretsCard
        secrets={loaded([keystore])}
        status={{
          locked: true,
          message:
            "The vault is locked: set HOT_UPDATER_VAULT_MASTER_KEY where the Console runs to seal and reveal secrets.",
        }}
      />,
    );

    expect(screen.getByText("The vault is locked")).toBeDefined();
    expect(
      (screen.getByRole("button", { name: "Add secret" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (
        screen.getByRole("button", {
          name: "Overwrite release-keystore",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      (
        screen.getByRole("button", {
          name: "Delete release-keystore",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  it("adds an App Store Connect key from its file, named after its kind", async () => {
    putMutation.mutateAsync.mockResolvedValue({
      name: "asc-api-key",
      version: 1,
    });
    render(<SecretsCard secrets={loaded([])} status={{ locked: false }} />);

    fireEvent.click(screen.getAllByRole("button", { name: "Add secret" })[0]!);
    const file = new File([P8], "AuthKey_ABC123DEFG.p8");
    fireEvent.change(screen.getByLabelText("Private key (.p8)"), {
      target: { files: [file] },
    });
    await waitFor(() => {
      expect(screen.getByDisplayValue("ABC123DEFG")).toBeDefined();
    });
    fireEvent.change(screen.getByLabelText("Issuer ID"), {
      target: { value: "issuer" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save secret" }));

    await waitFor(() => {
      expect(putMutation.mutateAsync).toHaveBeenCalledWith({
        name: "asc-api-key",
        kind: "asc-api-key",
        value: { p8: base64(P8), keyId: "ABC123DEFG", issuerId: "issuer" },
      });
    });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(toastSuccess).toHaveBeenCalledWith("asc-api-key saved");
  });

  it("names what a new secret is missing, and refuses a taken name", () => {
    render(
      <SecretsCard
        secrets={loaded([
          { ...keystore, name: "asc-api-key", kind: "asc-api-key" },
        ])}
        status={{ locked: false }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Add secret" }));
    fireEvent.click(screen.getByRole("button", { name: "Save secret" }));

    expect(screen.getByText(/already named asc-api-key/)).toBeDefined();
    expect(screen.getByText("Choose the private key (.p8).")).toBeDefined();
    expect(screen.getByText("Enter the issuer ID.")).toBeDefined();
    expect(putMutation.mutateAsync).not.toHaveBeenCalled();
  });

  it("overwrites a secret as its next version, starting empty", async () => {
    putMutation.mutateAsync.mockResolvedValue({
      name: "release-keystore",
      version: 4,
    });
    render(
      <SecretsCard secrets={loaded([keystore])} status={{ locked: false }} />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Overwrite release-keystore" }),
    );
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/Saves version 4/)).toBeDefined();
    expect(within(dialog).queryByLabelText("Name")).toBeNull();
    expect(
      (within(dialog).getByLabelText("Key alias") as HTMLInputElement).value,
    ).toBe("");
    fireEvent.change(within(dialog).getByLabelText("Keystore file"), {
      target: { files: [new File([new Uint8Array([0, 1, 2])], "release.jks")] },
    });
    await waitFor(() => {
      expect(within(dialog).getByText("release.jks")).toBeDefined();
    });
    for (const [label, value] of [
      ["Store password", " store "],
      ["Key alias", "upload"],
      ["Key password", "key"],
    ] as const) {
      fireEvent.change(within(dialog).getByLabelText(label), {
        target: { value },
      });
    }
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Save new version" }),
    );

    await waitFor(() => {
      expect(putMutation.mutateAsync).toHaveBeenCalledWith({
        name: "release-keystore",
        kind: "android-keystore",
        value: {
          keystore: btoa("\u0000\u0001\u0002"),
          storePassword: " store ",
          keyAlias: "upload",
          keyPassword: "key",
        },
      });
    });
    expect(toastSuccess).toHaveBeenCalledWith(
      "release-keystore is now version 4",
    );
  });

  it("deletes a secret after confirmation", async () => {
    removeMutation.mutateAsync.mockResolvedValue(keystore);
    render(
      <SecretsCard secrets={loaded([keystore])} status={{ locked: false }} />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Delete release-keystore" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete secret" }));

    expect(removeMutation.mutateAsync).toHaveBeenCalledWith(keystore.id);
    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });
  });
});

const token: VaultToken = {
  id: `tok-${"b".repeat(22)}`,
  name: "GitHub Actions",
  prefix: "hu_vault_AbCd",
  scope: {
    secrets: { names: ["release-keystore"], kinds: ["asc-api-key"] },
    actions: ["read"],
  },
  expiresAtMs: null,
  createdAtMs: 1_790_000_000_000,
  revokedAtMs: null,
};

describe("TokensCard", () => {
  it("lists a token's prefix and scope, and marks revoked and expired ones", () => {
    render(
      <TokensCard
        secrets={[keystore]}
        tokens={loaded([
          token,
          {
            ...token,
            id: `tok-${"c".repeat(22)}`,
            name: "Old",
            revokedAtMs: 1,
          },
          {
            ...token,
            id: `tok-${"d".repeat(22)}`,
            name: "Past",
            expiresAtMs: 1,
          },
        ])}
      />,
    );
    const row = screen.getByRole("row", { name: /GitHub Actions/ });

    expect(within(row).getByText("hu_vault_AbCd…")).toBeDefined();
    expect(within(row).getAllByText("release-keystore").length).toBeGreaterThan(
      0,
    );
    expect(
      within(row).getAllByText("Any App Store Connect API key").length,
    ).toBeGreaterThan(0);
    expect(
      within(row).getByRole("button", { name: "Revoke GitHub Actions" }),
    ).toBeDefined();
    expect(
      within(screen.getByRole("row", { name: /Old/ })).getByText("Revoked"),
    ).toBeDefined();
    expect(
      within(screen.getByRole("row", { name: /Past/ })).getByText("Expired"),
    ).toBeDefined();
  });

  it("issues a token, shows it once with the CI variables, and forgets it", async () => {
    const plaintext = `hu_vault_${"x".repeat(43)}`;
    issueMutation.mutateAsync.mockResolvedValue({
      token: plaintext,
      metadata: token,
    });
    render(
      <TokensCard
        secrets={[
          keystore,
          {
            ...keystore,
            id: `sec-${"e".repeat(22)}`,
            name: "bundle-signing-key",
            kind: "bundle-signing-key",
          },
        ]}
        tokens={loaded([])}
      />,
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Issue token" })[0]!);
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: " GitHub Actions " },
    });
    fireEvent.click(screen.getByRole("button", { name: "release-keystore" }));
    expect(screen.queryByRole("button", { name: "Sign bundles" })).toBeNull();
    // A read token never reaches a bundle signing key, by kind or by name.
    expect(
      screen.queryByRole("button", { name: "Bundle signing key" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "bundle-signing-key" }),
    ).toBeNull();
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Issue token",
      }),
    );

    expect(await screen.findByDisplayValue(plaintext)).toBeDefined();
    expect(issueMutation.mutateAsync).toHaveBeenCalledWith({
      name: "GitHub Actions",
      scope: {
        secrets: { names: ["release-keystore"] },
        actions: ["read"],
      },
      expiresAtMs: expect.any(Number),
    });
    expect(
      screen.getByText(
        `HOT_UPDATER_CONSOLE_URL=${window.location.origin} HOT_UPDATER_VAULT_TOKEN=${plaintext}`,
        { normalizer: (text) => text.replace(/\s+/gu, " ").trim() },
      ),
    ).toBeDefined();
    expect(screen.getByText("Shown once")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Issue token" })[0]!);

    expect(screen.queryByDisplayValue(plaintext)).toBeNull();
  });

  it("asks for a scope before it issues", () => {
    render(<TokensCard secrets={[]} tokens={loaded([])} />);

    fireEvent.click(screen.getAllByRole("button", { name: "Issue token" })[0]!);
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "CI" },
    });
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Issue token",
      }),
    );

    expect(
      screen.getByText("Choose at least one secret or kind."),
    ).toBeDefined();
    expect(issueMutation.mutateAsync).not.toHaveBeenCalled();
  });
});
