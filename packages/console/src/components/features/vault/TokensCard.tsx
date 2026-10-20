import type { VaultSecret, VaultToken } from "@hot-updater/server/plugins";
import {
  AlertTriangle,
  KeyRound,
  Plus,
  RefreshCw,
  ShieldOff,
} from "lucide-react";
import { type MouseEvent, useState } from "react";
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
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
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
import { useRevokeVaultTokenMutation } from "@/lib/vault-api";
import { vaultSecretKinds, vaultTokenState } from "@/lib/vault-secrets";

import { IssueTokenDialog } from "./IssueTokenDialog";

/** A time as a date, inside a `time` element when a `Date` can hold it. */
function DateText({ ms }: { readonly ms: number }) {
  const date = new Date(ms);
  // The vault takes any safe integer, beyond the dates `Date` holds.
  if (Number.isNaN(date.getTime())) return <>Far future</>;
  return (
    <time dateTime={date.toISOString()}>{date.toISOString().slice(0, 10)}</time>
  );
}

const ACTION_LABELS = {
  read: "Read",
  sign: "Sign",
  write: "Write",
} as const satisfies Record<VaultToken["scope"]["actions"][number], string>;

/** The secrets and actions a token reaches, as badges and a line of text. */
function TokenScope({ token }: { readonly token: VaultToken }) {
  const { names = [], kinds = [] } = token.scope.secrets;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex flex-wrap gap-1">
        {names.map((name) => (
          <Badge
            className="break-all font-mono font-medium"
            key={`name:${name}`}
            variant="outline"
          >
            {name}
          </Badge>
        ))}
        {kinds.map((kind) => (
          <Badge
            className="font-medium"
            key={`kind:${kind}`}
            variant="secondary"
          >
            Any {vaultSecretKinds[kind]?.label ?? kind}
          </Badge>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        {token.scope.actions.map((action) => ACTION_LABELS[action]).join(" · ")}
      </p>
    </div>
  );
}

function RevokeTokenDialog({ token }: { readonly token: VaultToken }) {
  const [open, setOpen] = useState(false);
  const revoke = useRevokeVaultTokenMutation();
  const handleRevoke = async (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    try {
      await revoke.mutateAsync(token.id);
      setOpen(false);
      toast.success("Vault token revoked");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Unable to revoke the token",
      );
    }
  };
  return (
    <AlertDialog
      onOpenChange={(next) => {
        if (!revoke.isPending) setOpen(next);
      }}
      open={open}
    >
      <AlertDialogTrigger
        render={
          <Button
            aria-label={`Revoke ${token.name}`}
            className="min-h-11 sm:min-h-7"
            size="sm"
            variant="ghost"
          />
        }
      >
        <ShieldOff data-icon="inline-start" />
        Revoke
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia>
            <ShieldOff />
          </AlertDialogMedia>
          <AlertDialogTitle>Revoke {token.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            CI using {token.prefix}… loses access to the vault from its next
            request. This action cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={revoke.isPending}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={revoke.isPending}
            onClick={(event) => void handleRevoke(event)}
            variant="destructive"
          >
            Revoke token
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function TokensCard({
  tokens,
  secrets,
}: {
  readonly tokens: {
    readonly data: readonly VaultToken[] | undefined;
    readonly isError: boolean;
    readonly isLoading: boolean;
    readonly refetch: () => unknown;
  };
  readonly secrets: readonly VaultSecret[];
}) {
  const [issuing, setIssuing] = useState(false);
  const now = Date.now();

  return (
    <Card className="overflow-hidden shadow-sm">
      <CardHeader className="flex-row items-center justify-between space-y-0 border-b px-4 py-3">
        <CardTitle className="text-sm">
          <h2>Vault tokens</h2>
        </CardTitle>
        <Button
          className="min-h-11 sm:min-h-8"
          onClick={() => setIssuing(true)}
        >
          <Plus data-icon="inline-start" />
          Issue token
        </Button>
      </CardHeader>
      <CardContent className="p-0">
        {tokens.isError ? (
          <div className="p-4">
            <Alert variant="destructive">
              <AlertTriangle />
              <AlertTitle>Vault tokens couldn't be loaded</AlertTitle>
              <AlertDescription>
                Check your connection and try again.
              </AlertDescription>
              <AlertAction>
                <Button
                  onClick={() => void tokens.refetch()}
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
          <Table aria-label="Vault tokens" className="table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead>Token</TableHead>
                <TableHead className="hidden md:table-cell">Scope</TableHead>
                <TableHead className="hidden w-28 md:table-cell">
                  Expires
                </TableHead>
                <TableHead className="hidden w-28 md:table-cell">
                  Created
                </TableHead>
                <TableHead className="w-28 text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tokens.isLoading ? (
                Array.from({ length: 3 }, (_, index) => (
                  <TableRow key={index}>
                    <TableCell className="space-y-2 py-3">
                      {index === 0 ? (
                        <span className="sr-only">Loading vault tokens</span>
                      ) : null}
                      <Skeleton className="h-3.5 w-32" />
                      <Skeleton className="h-3 w-20" />
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      <Skeleton className="h-5 w-32" />
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      <Skeleton className="h-3.5 w-20" />
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      <Skeleton className="h-3.5 w-20" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="ml-auto h-6 w-16" />
                    </TableCell>
                  </TableRow>
                ))
              ) : tokens.data?.length === 0 ? (
                <TableRow>
                  <TableCell
                    className="h-44 text-center text-muted-foreground"
                    colSpan={5}
                  >
                    <div className="mx-auto flex max-w-xs flex-col items-center gap-2 whitespace-normal">
                      <KeyRound className="size-5" />
                      <p className="font-medium text-foreground">
                        No vault tokens
                      </p>
                      <p>Issue a token so CI can read the secrets it needs.</p>
                      <Button
                        className="mt-1 min-h-11 sm:min-h-8"
                        onClick={() => setIssuing(true)}
                        size="sm"
                        variant="outline"
                      >
                        <Plus data-icon="inline-start" />
                        Issue token
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ) : (
                tokens.data?.map((token) => {
                  const state = vaultTokenState(token, now);
                  const expires =
                    token.expiresAtMs === null ? (
                      "Never"
                    ) : (
                      <DateText ms={token.expiresAtMs} />
                    );
                  return (
                    <TableRow
                      className={
                        state === "active" ? undefined : "text-muted-foreground"
                      }
                      key={token.id}
                    >
                      <TableCell className="whitespace-normal py-3 align-top">
                        <div className="min-w-0 space-y-1">
                          <p className="break-words font-medium text-foreground">
                            {token.name}
                          </p>
                          <p className="font-mono text-xs text-muted-foreground">
                            {token.prefix}…
                          </p>
                          <div className="pt-1 md:hidden">
                            <TokenScope token={token} />
                            <p className="mt-1 text-xs text-muted-foreground">
                              Expires {expires} · created{" "}
                              <DateText ms={token.createdAtMs} />
                            </p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="hidden whitespace-normal py-3 align-top md:table-cell">
                        <TokenScope token={token} />
                      </TableCell>
                      <TableCell className="hidden py-3 align-top text-xs text-muted-foreground md:table-cell">
                        {expires}
                      </TableCell>
                      <TableCell className="hidden py-3 align-top text-xs text-muted-foreground md:table-cell">
                        <DateText ms={token.createdAtMs} />
                      </TableCell>
                      <TableCell className="py-3 text-right align-top">
                        {state === "active" ? (
                          <RevokeTokenDialog token={token} />
                        ) : (
                          <Badge variant="outline">
                            {state === "revoked" ? "Revoked" : "Expired"}
                          </Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        )}
      </CardContent>
      <IssueTokenDialog
        onOpenChange={setIssuing}
        open={issuing}
        secrets={secrets}
      />
    </Card>
  );
}
