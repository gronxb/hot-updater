import type {
  VaultMasterKeys,
  VaultMasterKeyStatus,
  VaultStatus,
} from "@hot-updater/server/plugins";
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  KeyRound,
  RefreshCw,
  RotateCw,
} from "lucide-react";
import { Fragment, useState } from "react";
import { toast } from "sonner";

import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useRewrapVaultMutation } from "@/lib/vault-api";

import { MASTER_KEY_COMMAND, VaultLockedAlert } from "./SecretsCard";

const KEYS_ENV = "HOT_UPDATER_VAULT_MASTER_KEYS";

const versionsText = (count: number) =>
  `${count.toLocaleString()} ${count === 1 ? "version" : "versions"}`;

/** Kids as code, separated by commas. */
function KidList({ kids }: { readonly kids: readonly string[] }) {
  return kids.map((kid, index) => (
    <Fragment key={kid}>
      {index === 0 ? null : ", "}
      <code className="font-mono">{kid}</code>
    </Fragment>
  ));
}

/**
 * What a key is to the rotation, as a badge: neutral for keys as they
 * should be, and color only for a key the console lacks.
 */
function KeyRole({ entry }: { readonly entry: VaultMasterKeyStatus }) {
  if (entry.active) return <Badge variant="secondary">Active</Badge>;
  if (!entry.held) return <Badge variant="warning">Not in this console</Badge>;
  // Still known to the vault: a rewrap moves its versions and forgets it.
  return entry.known ? (
    <Badge variant="outline">Rotating out</Badge>
  ) : (
    <Badge className="text-muted-foreground" variant="outline">
      Unused
    </Badge>
  );
}

/**
 * The master keys and the stored versions under each, and the rotation to
 * the active key: Rewrap moves every version the console can open to it,
 * batch by batch, and says which keys can then leave the environment.
 */
export function MasterKeysCard({
  keys,
  status,
}: {
  readonly keys: {
    readonly data: VaultMasterKeys | undefined;
    readonly isError: boolean;
    readonly isLoading: boolean;
    readonly refetch: () => unknown;
  };
  readonly status: {
    readonly data: VaultStatus | undefined;
    readonly refetch: () => unknown;
  };
}) {
  const rewrap = useRewrapVaultMutation();
  // The count when the rewrap started, and what is left, while it runs.
  const [progress, setProgress] = useState<{
    readonly from: number;
    readonly left: number;
  } | null>(null);
  const entries = keys.data?.keys ?? [];
  const active = entries.find((entry) => entry.active);
  const others = entries.filter((entry) => !entry.active);
  const movable = others
    .filter((entry) => entry.held)
    .reduce((sum, entry) => sum + entry.versions, 0);
  const stranded = others.filter((entry) => !entry.held && entry.versions > 0);
  // Known to the vault with nothing under it, such as after every secret
  // was deleted: a rewrap only has to forget it.
  const forgettable = others.filter(
    (entry) => entry.known && entry.versions === 0,
  );
  const unused = others.filter((entry) => entry.held && !entry.known);
  const locked = status.data?.locked === true;
  const pending = movable > 0 || forgettable.length > 0;
  const canRewrap =
    !locked && active !== undefined && pending && !rewrap.isPending;

  const runRewrap = async () => {
    const from = keys.data?.remaining ?? 0;
    setProgress({ from, left: from });
    try {
      const result = await rewrap.mutateAsync({
        onProgress: (left) => setProgress({ from, left }),
      });
      toast.success(
        result.rewrapped === 0
          ? "Nothing to rewrap"
          : `Rewrapped ${versionsText(result.rewrapped)}`,
      );
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Unable to rewrap the vault",
      );
    } finally {
      setProgress(null);
    }
  };

  const copyCommand = async () => {
    try {
      await navigator.clipboard.writeText(MASTER_KEY_COMMAND);
      toast.success("Command copied");
    } catch {
      toast.error("Could not copy the command");
    }
  };

  return (
    <Card className="overflow-hidden shadow-sm">
      <CardHeader className="flex-row items-center justify-between space-y-0 border-b px-4 py-3">
        <CardTitle className="text-sm">
          <h2>Master keys</h2>
        </CardTitle>
        {/* Offered only while some version can move. */}
        {!pending && !rewrap.isPending ? null : (
          <Button
            className="min-h-11 sm:min-h-8"
            disabled={!canRewrap}
            onClick={() => void runRewrap()}
          >
            <RotateCw
              className={
                rewrap.isPending ? "motion-safe:animate-spin" : undefined
              }
              data-icon="inline-start"
            />
            {rewrap.isPending
              ? "Rewrapping…"
              : movable > 0
                ? `Rewrap ${versionsText(movable)}`
                : "Finish rotation"}
          </Button>
        )}
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
        ) : null}
        {progress !== null ? (
          <div className="flex flex-col gap-2 border-b p-4">
            <p className="text-sm">
              Rewrapping to <code className="font-mono">{active?.kid}</code>:{" "}
              <span className="tabular-nums">
                {versionsText(progress.left)}
              </span>{" "}
              left
            </p>
            <Progress
              aria-label="Rewrap progress"
              value={
                progress.from === 0
                  ? 100
                  : ((progress.from - progress.left) / progress.from) * 100
              }
            />
          </div>
        ) : keys.data === undefined || locked ? null : stranded.length > 0 ? (
          <div className="border-b p-4">
            <Alert>
              <AlertTriangle />
              <AlertTitle>
                Some versions need a key this console lacks
              </AlertTitle>
              <AlertDescription>
                Versions under <KidList kids={stranded.map(({ kid }) => kid)} />{" "}
                stay where they are. Add the key after the active one in{" "}
                <code className="font-mono">{KEYS_ENV}</code> and redeploy the
                console to rewrap them.
              </AlertDescription>
            </Alert>
          </div>
        ) : movable > 0 ? (
          <div className="border-b p-4">
            <Alert>
              <RotateCw />
              <AlertTitle>
                {versionsText(movable)} still {movable === 1 ? "uses" : "use"}{" "}
                an older key
              </AlertTitle>
              <AlertDescription>
                Rewrap seals their data keys again under{" "}
                <code className="font-mono">{active?.kid}</code>. Values are not
                decrypted, and CI keeps resolving them while it runs.
              </AlertDescription>
            </Alert>
          </div>
        ) : forgettable.length > 0 ? (
          <div className="border-b p-4">
            <Alert>
              <RotateCw />
              <AlertTitle>Finish the rotation to {active?.kid}</AlertTitle>
              <AlertDescription>
                No version uses{" "}
                <KidList kids={forgettable.map(({ kid }) => kid)} />, but the
                vault still accepts only{" "}
                {forgettable.length === 1 ? "that key" : "those keys"}. Finish
                the rotation so it records{" "}
                <code className="font-mono">{active?.kid}</code> and forgets{" "}
                {forgettable.length === 1 ? "it" : "them"}, before removing{" "}
                {forgettable.length === 1 ? "it" : "them"} from the environment.
              </AlertDescription>
            </Alert>
          </div>
        ) : unused.length > 0 ? (
          <div className="border-b p-4">
            <Alert>
              <CheckCircle2 />
              <AlertTitle>Every version uses {active?.kid}</AlertTitle>
              <AlertDescription>
                Remove <KidList kids={unused.map(({ kid }) => kid)} /> from{" "}
                <code className="font-mono">{KEYS_ENV}</code> or{" "}
                <code className="font-mono">HOT_UPDATER_VAULT_MASTER_KEY</code>{" "}
                and redeploy the console. The vault no longer opens with{" "}
                {unused.length === 1 ? "it" : "them"} alone.
              </AlertDescription>
            </Alert>
          </div>
        ) : null}
        {keys.isError ? (
          <div className="p-4">
            <Alert variant="destructive">
              <AlertTriangle />
              <AlertTitle>Master keys couldn't be loaded</AlertTitle>
              <AlertDescription>
                Check your connection and try again.
              </AlertDescription>
              <AlertAction>
                <Button
                  onClick={() => void keys.refetch()}
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
          <Table aria-label="Master keys" className="table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead>Key ID</TableHead>
                <TableHead className="w-32 sm:w-44">Role</TableHead>
                <TableHead className="w-20 text-right sm:w-32">
                  Versions
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {keys.isLoading ? (
                Array.from({ length: 2 }, (_, index) => (
                  <TableRow key={index}>
                    <TableCell className="py-3">
                      {index === 0 ? (
                        <span className="sr-only">Loading master keys</span>
                      ) : null}
                      <Skeleton className="h-3.5 w-24" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-5 w-20" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="ml-auto h-3.5 w-8" />
                    </TableCell>
                  </TableRow>
                ))
              ) : entries.length === 0 ? (
                <TableRow>
                  <TableCell
                    className="h-36 text-center text-muted-foreground"
                    colSpan={3}
                  >
                    <div className="mx-auto flex max-w-xs flex-col items-center gap-2 whitespace-normal">
                      <KeyRound className="size-5" />
                      <p className="font-medium text-foreground">
                        No master key
                      </p>
                      <p>Set one where the console runs to store secrets.</p>
                    </div>
                  </TableCell>
                </TableRow>
              ) : (
                entries.map((entry) => (
                  <TableRow key={entry.kid}>
                    <TableCell className="py-3 font-mono break-all whitespace-normal">
                      {entry.kid}
                    </TableCell>
                    <TableCell className="py-3">
                      <KeyRole entry={entry} />
                    </TableCell>
                    <TableCell className="py-3 text-right tabular-nums">
                      {entry.versions.toLocaleString()}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        )}
        {keys.data !== undefined && others.length === 0 && !locked ? (
          <div className="flex flex-col gap-3 border-t p-4 text-sm text-muted-foreground">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p>
                To rotate, generate a key and list it before the current one,
                then redeploy the console and rewrap here.
              </p>
              <Button
                className="min-h-11 shrink-0 sm:min-h-7"
                onClick={() => void copyCommand()}
                size="sm"
                variant="outline"
              >
                <Copy data-icon="inline-start" />
                Copy key command
              </Button>
            </div>
            <code className="block overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs whitespace-nowrap text-foreground">
              {`${KEYS_ENV}="new:<key>,${active?.kid ?? "default"}:<current key>"`}
            </code>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
