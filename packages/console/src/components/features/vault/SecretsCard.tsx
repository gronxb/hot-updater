import type { VaultSecret, VaultStatus } from "@hot-updater/server/plugins";
import {
  AlertTriangle,
  Copy,
  FilePen,
  LockKeyhole,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { Fragment, type MouseEvent, useState } from "react";
import { toast } from "sonner";

import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useRemoveVaultSecretMutation } from "@/lib/vault-api";
import { vaultSecretKinds } from "@/lib/vault-secrets";

import { SecretDialog } from "./SecretDialog";

export const MASTER_KEY_COMMAND = "openssl rand -base64 32";

const formatDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** What a secret's metadata shows without its values. */
export const secretDetails = ({ kind, metadata }: VaultSecret): string => {
  const text = (key: string) =>
    typeof metadata[key] === "string" ? (metadata[key] as string) : undefined;
  switch (kind) {
    case "asc-api-key":
      return text("keyId") ? `Key ID ${text("keyId")}` : "";
    case "android-keystore":
      return text("keyAlias") ? `Alias ${text("keyAlias")}` : "";
    case "play-service-account":
      return text("clientEmail") ?? "";
    case "bundle-signing-key": {
      const sha256 = text("publicKeySha256");
      const bits =
        typeof metadata.bits === "number" ? `RSA ${metadata.bits} · ` : "";
      // Its first 16 hex digits, as a fingerprint is compared.
      return sha256 ? `${bits}SHA-256 ${sha256.slice(0, 16)}…` : "";
    }
    case "deploy-credentials":
    case "generic": {
      const variables = Array.isArray(metadata.variables)
        ? metadata.variables.map(String)
        : [];
      return variables.join(", ");
    }
    default:
      return "";
  }
};

/** The vault's reason without the "The vault is locked:" the title already says. */
const lockedReason = (message: string) => {
  const reason = message.replace(/^The vault is locked:\s*/u, "");
  return reason.charAt(0).toUpperCase() + reason.slice(1);
};

/**
 * Why the console cannot store secrets, and what fixes it: a new key only
 * for a vault that has sealed nothing; otherwise the keys it was sealed
 * with, which no new key opens.
 */
export function VaultLockedAlert({
  message,
  knownKeys,
  onCheckAgain,
}: {
  readonly message: string;
  /** The kids the vault was sealed under; none while any key would do. */
  readonly knownKeys: readonly string[];
  readonly onCheckAgain: () => Promise<unknown>;
}) {
  const empty = knownKeys.length === 0;
  const [checking, setChecking] = useState(false);
  const copyCommand = async () => {
    try {
      await navigator.clipboard.writeText(MASTER_KEY_COMMAND);
      toast.success("Command copied");
    } catch {
      toast.error("Could not copy the command");
    }
  };
  const checkAgain = async () => {
    setChecking(true);
    try {
      await onCheckAgain();
    } finally {
      setChecking(false);
    }
  };
  return (
    <Alert>
      <LockKeyhole />
      <AlertTitle>The vault is locked</AlertTitle>
      <AlertDescription>
        <p>{lockedReason(message)}</p>
        {!empty ? (
          <p>
            Redeploy the console with the{" "}
            {knownKeys.length === 1 ? "key" : "keys"} the vault's secrets were
            saved with (
            {knownKeys.map((kid, index) => (
              <Fragment key={kid}>
                {index === 0 ? null : ", "}
                <code className="font-mono">{kid}</code>
              </Fragment>
            ))}
            ): a new key can't open them. Listing, deleting, and tokens keep
            working.
          </p>
        ) : (
          <p>
            Generate a key with{" "}
            <code className="font-mono">{MASTER_KEY_COMMAND}</code> and redeploy
            the console. Listing, deleting, and tokens keep working.
          </p>
        )}
      </AlertDescription>
      {/* Below the text, which a long reason would run under. */}
      <div className="col-start-2 mt-2 flex flex-wrap gap-1">
        {!empty ? null : (
          <Button
            className="min-h-11 sm:min-h-6"
            onClick={() => void copyCommand()}
            size="xs"
            variant="outline"
          >
            <Copy data-icon="inline-start" />
            Copy command
          </Button>
        )}
        <Button
          className="min-h-11 sm:min-h-6"
          disabled={checking}
          onClick={() => void checkAgain()}
          size="xs"
          variant="outline"
        >
          <RefreshCw
            className={checking ? "motion-safe:animate-spin" : undefined}
            data-icon="inline-start"
          />
          {checking ? "Checking…" : "Check again"}
        </Button>
      </div>
    </Alert>
  );
}

function DeleteSecretDialog({
  secret,
  onOpenChange,
}: {
  readonly secret: VaultSecret | null;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const remove = useRemoveVaultSecretMutation();
  const handleDelete = async (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    if (secret === null) return;
    try {
      await remove.mutateAsync(secret);
      onOpenChange(false);
      toast.success(`${secret.name} deleted`);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Unable to delete the secret",
      );
      // The secret may have changed since it was confirmed, such as a newer
      // version: confirming again starts from its row.
      onOpenChange(false);
    }
  };
  return (
    <AlertDialog
      onOpenChange={(open) => {
        if (!remove.isPending) onOpenChange(open);
      }}
      open={secret !== null}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia>
            <Trash2 />
          </AlertDialogMedia>
          <AlertDialogTitle>
            Delete {secret?.name} (version {secret?.version})?
          </AlertDialogTitle>
          <AlertDialogDescription>
            Its values are deleted with every kept version. CI builds that
            resolve it fail until you add it again.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={remove.isPending}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={remove.isPending}
            onClick={(event) => void handleDelete(event)}
            variant="destructive"
          >
            Delete secret
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function SecretsCard({
  secrets,
  status,
}: {
  readonly secrets: {
    readonly data: readonly VaultSecret[] | undefined;
    readonly isError: boolean;
    readonly isLoading: boolean;
    readonly refetch: () => unknown;
  };
  readonly status: {
    readonly data: VaultStatus | undefined;
    readonly isError: boolean;
    readonly refetch: () => unknown;
  };
}) {
  // `undefined` while closed, `null` to add one, an id to overwrite it. The
  // overwrite dialog reads the secret from the list, and says which version
  // it saves, so after a write is refused and the list reloads, a retry
  // uses the current version, and a secret deleted meanwhile closes it.
  const [editing, setEditing] = useState<string | null | undefined>(undefined);
  // The secret as the user confirmed it: a delete names that version, and
  // the dialog closes if the secret leaves the list.
  const [deleting, setDeleting] = useState<VaultSecret | null>(null);
  const secretOf = (id: string | null | undefined) =>
    id ? secrets.data?.find((secret) => secret.id === id) : undefined;
  const editingSecret = secretOf(editing);
  const deletingSecret =
    deleting !== null && secretOf(deleting.id) !== undefined ? deleting : null;
  // Writes wait for the vault to say it holds a key.
  const locked = status.data?.locked !== false;
  // Adding checks names against the list, so it waits for one.
  const canAdd = !locked && secrets.data !== undefined && !secrets.isError;

  return (
    <Card className="overflow-hidden shadow-sm">
      <CardHeader className="flex-row items-center justify-between space-y-0 border-b px-4 py-3">
        <CardTitle className="text-sm">
          <h2>Secrets</h2>
        </CardTitle>
        <Button
          className="min-h-11 sm:min-h-8"
          disabled={!canAdd}
          onClick={() => setEditing(null)}
        >
          <Plus data-icon="inline-start" />
          Add secret
        </Button>
      </CardHeader>
      <CardContent className="p-0">
        {status.data?.locked === true ? (
          <div className="border-b p-4">
            <VaultLockedAlert
              knownKeys={status.data.knownKeys}
              message={status.data.message}
              onCheckAgain={async () => status.refetch()}
            />
          </div>
        ) : status.isError ? (
          <div className="border-b p-4">
            <Alert variant="destructive">
              <AlertTriangle />
              <AlertTitle>Couldn't check the vault's master key</AlertTitle>
              <AlertDescription>
                Adding and overwriting secrets wait for it. Try again.
              </AlertDescription>
              <AlertAction>
                <Button
                  onClick={() => void status.refetch()}
                  size="xs"
                  variant="outline"
                >
                  <RefreshCw data-icon="inline-start" />
                  Retry
                </Button>
              </AlertAction>
            </Alert>
          </div>
        ) : null}
        {secrets.isError ? (
          <div className="p-4">
            <Alert variant="destructive">
              <AlertTriangle />
              <AlertTitle>Secrets couldn't be loaded</AlertTitle>
              <AlertDescription>
                Check your connection and try again.
              </AlertDescription>
              <AlertAction>
                <Button
                  onClick={() => void secrets.refetch()}
                  size="xs"
                  variant="outline"
                >
                  <RefreshCw data-icon="inline-start" />
                  Retry
                </Button>
              </AlertAction>
            </Alert>
          </div>
        ) : (
          <Table aria-label="Secrets" className="table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead>Secret</TableHead>
                <TableHead className="hidden md:table-cell">Details</TableHead>
                <TableHead className="hidden w-20 md:table-cell">
                  Version
                </TableHead>
                <TableHead className="hidden w-28 md:table-cell">
                  Updated
                </TableHead>
                <TableHead className="w-28 text-right sm:w-48">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {secrets.isLoading ? (
                Array.from({ length: 3 }, (_, index) => (
                  <TableRow key={index}>
                    <TableCell className="space-y-2 py-3">
                      {index === 0 ? (
                        <span className="sr-only">Loading secrets</span>
                      ) : null}
                      <Skeleton className="h-3.5 w-32" />
                      <Skeleton className="h-3 w-24" />
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      <Skeleton className="h-3.5 w-28" />
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      <Skeleton className="h-3.5 w-6" />
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      <Skeleton className="h-3.5 w-20" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="ml-auto h-6 w-20" />
                    </TableCell>
                  </TableRow>
                ))
              ) : secrets.data?.length === 0 ? (
                <TableRow>
                  <TableCell
                    className="h-44 text-center text-muted-foreground"
                    colSpan={5}
                  >
                    <div className="mx-auto flex max-w-xs flex-col items-center gap-2 whitespace-normal">
                      <LockKeyhole className="size-5" />
                      <p className="font-medium text-foreground">No secrets</p>
                      <p>
                        Add the signing keys and deploy credentials your CI
                        builds with.
                      </p>
                      <Button
                        className="mt-1 min-h-11 sm:min-h-8"
                        disabled={!canAdd}
                        onClick={() => setEditing(null)}
                        size="sm"
                        variant="outline"
                      >
                        <Plus data-icon="inline-start" />
                        Add secret
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ) : (
                secrets.data?.map((secret) => {
                  const details = secretDetails(secret);
                  const updated = (
                    <time dateTime={new Date(secret.updatedAtMs).toISOString()}>
                      {formatDate(secret.updatedAtMs)}
                    </time>
                  );
                  return (
                    <TableRow key={secret.id}>
                      <TableCell className="whitespace-normal py-3">
                        <div className="min-w-0 space-y-1">
                          <p className="break-all font-mono font-medium text-foreground">
                            {secret.name}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {vaultSecretKinds[secret.kind]?.label ??
                              secret.kind}
                          </p>
                          <p className="text-xs text-muted-foreground md:hidden">
                            {details ? (
                              <span className="break-words">{details} · </span>
                            ) : null}
                            <span className="tabular-nums">
                              v{secret.version} · {updated}
                            </span>
                          </p>
                        </div>
                      </TableCell>
                      <TableCell className="hidden whitespace-normal text-xs text-muted-foreground md:table-cell">
                        <span className="break-words">{details || "—"}</span>
                      </TableCell>
                      <TableCell className="hidden text-xs tabular-nums md:table-cell">
                        {secret.version}
                      </TableCell>
                      <TableCell className="hidden text-xs text-muted-foreground md:table-cell">
                        {updated}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex flex-col items-end gap-1 sm:flex-row sm:justify-end">
                          <Button
                            aria-label={`Overwrite ${secret.name}`}
                            className="min-h-11 sm:min-h-7"
                            disabled={locked}
                            onClick={() => setEditing(secret.id)}
                            size="sm"
                            variant="ghost"
                          >
                            <FilePen data-icon="inline-start" />
                            Overwrite
                          </Button>
                          <Button
                            aria-label={`Delete ${secret.name}`}
                            className="min-h-11 sm:min-h-7"
                            onClick={() => setDeleting(secret)}
                            size="sm"
                            variant="ghost"
                          >
                            <Trash2 data-icon="inline-start" />
                            Delete
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        )}
      </CardContent>
      <SecretDialog
        onOpenChange={(open) => {
          if (!open) setEditing(undefined);
        }}
        open={editing === null || editingSecret !== undefined}
        secret={editingSecret}
        secrets={secrets.data ?? []}
      />
      <DeleteSecretDialog
        onOpenChange={() => setDeleting(null)}
        secret={deletingSecret}
      />
    </Card>
  );
}
