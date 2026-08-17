import {
  AlertTriangle,
  Check,
  Clipboard,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  ShieldOff,
} from "lucide-react";
import { type FormEvent, type MouseEvent, useState } from "react";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  useCreateClientAccessKeyMutation,
  useClientAccessKeysQuery,
  useRevokeClientAccessKeyMutation,
} from "@/lib/access-keys-api";
import type { ClientAccessKeyView } from "@/lib/access-keys-rpc";

const formatCreatedAt = (createdAt: number): string =>
  new Date(createdAt).toISOString().slice(0, 10);

function CreateAccessKeyDialog() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [apiKey, setApiKey] = useState<string | null>(null);
  const create = useCreateClientAccessKeyMutation();
  const normalizedName = name.trim();
  const nameError =
    normalizedName.length > 64 ? "Name must be 64 characters or fewer." : null;

  const reset = () => {
    setName("");
    setApiKey(null);
    create.reset();
  };

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) reset();
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (normalizedName.length === 0 || nameError !== null) return;
    try {
      const result = await create.mutateAsync(normalizedName);
      setApiKey(result.apiKey);
      toast.success("Access key created");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Unable to create key",
      );
    }
  };

  const copyKey = async () => {
    if (apiKey === null) return;
    try {
      await navigator.clipboard.writeText(apiKey);
      toast.success("Access key copied");
    } catch {
      toast.error("Unable to copy access key");
    }
  };

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus data-icon="inline-start" />
        Create key
      </Button>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent showCloseButton={apiKey === null}>
          <DialogHeader>
            <DialogTitle>
              {apiKey === null ? "Create access key" : "Save your access key"}
            </DialogTitle>
            <DialogDescription>
              {apiKey === null
                ? "Name the app or environment that will use this key."
                : "This key is shown once. Store it securely before closing."}
            </DialogDescription>
          </DialogHeader>
          {apiKey === null ? (
            <form onSubmit={handleSubmit}>
              <FieldGroup>
                <Field data-invalid={nameError !== null || undefined}>
                  <FieldLabel htmlFor="access-key-name">Name</FieldLabel>
                  <Input
                    id="access-key-name"
                    autoComplete="off"
                    maxLength={65}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="Production app"
                    value={name}
                  />
                  <FieldDescription>
                    Use a name you can identify before revoking the key.
                  </FieldDescription>
                  <FieldError>{nameError}</FieldError>
                </Field>
              </FieldGroup>
              <DialogFooter className="mt-4">
                <Button
                  disabled={
                    create.isPending ||
                    normalizedName.length === 0 ||
                    nameError !== null
                  }
                  type="submit"
                >
                  {create.isPending ? (
                    <Loader2
                      data-icon="inline-start"
                      className="animate-spin"
                    />
                  ) : (
                    <KeyRound data-icon="inline-start" />
                  )}
                  Create key
                </Button>
              </DialogFooter>
            </form>
          ) : (
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="created-access-key">Access key</FieldLabel>
                <div className="flex gap-2">
                  <Input
                    id="created-access-key"
                    className="font-mono"
                    readOnly
                    value={apiKey}
                  />
                  <Button onClick={copyKey} type="button" variant="outline">
                    <Clipboard data-icon="inline-start" />
                    Copy
                  </Button>
                </div>
              </Field>
              <DialogFooter>
                <Button onClick={() => handleOpenChange(false)}>
                  <Check data-icon="inline-start" />
                  Done
                </Button>
              </DialogFooter>
            </FieldGroup>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function RevokeAccessKeyDialog({ record }: { record: ClientAccessKeyView }) {
  const [open, setOpen] = useState(false);
  const revoke = useRevokeClientAccessKeyMutation();

  const handleRevoke = async (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    try {
      await revoke.mutateAsync(record.id);
      setOpen(false);
      toast.success("Access key revoked");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Unable to revoke key",
      );
    }
  };

  return (
    <AlertDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!revoke.isPending) setOpen(nextOpen);
      }}
    >
      <AlertDialogTrigger render={<Button size="sm" variant="ghost" />}>
        <ShieldOff data-icon="inline-start" />
        Revoke
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia>
            <ShieldOff />
          </AlertDialogMedia>
          <AlertDialogTitle>Revoke {record.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            Apps using {record.prefix}… will immediately lose OTA update and
            analytics access. This action cannot be undone.
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
            Revoke key
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function AccessKeysPage() {
  const accessKeys = useClientAccessKeysQuery();

  return (
    <Card className="overflow-hidden shadow-sm">
      <CardHeader className="flex-row items-center justify-between space-y-0 border-b px-4 py-3">
        <CardTitle className="text-sm">
          <h2>Keys</h2>
        </CardTitle>
        <CreateAccessKeyDialog />
      </CardHeader>
      <CardContent className="p-0">
        {accessKeys.isError ? (
          <div className="p-4">
            <Alert variant="destructive">
              <AlertTriangle />
              <AlertTitle>Access keys couldn't be loaded</AlertTitle>
              <AlertDescription>
                Check your connection and try again.
              </AlertDescription>
              <AlertAction>
                <Button
                  onClick={() => void accessKeys.refetch()}
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
          <Table aria-label="Client access keys" className="table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead>Key</TableHead>
                <TableHead className="w-32">Created</TableHead>
                <TableHead className="w-24 text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {accessKeys.isLoading ? (
                Array.from({ length: 3 }, (_, index) => (
                  <TableRow key={index}>
                    <TableCell className="space-y-2 py-3">
                      {index === 0 ? (
                        <span className="sr-only">Loading access keys</span>
                      ) : null}
                      <Skeleton className="h-3.5 w-32" />
                      <Skeleton className="h-3 w-20" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-3.5 w-20" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="ml-auto h-6 w-16" />
                    </TableCell>
                  </TableRow>
                ))
              ) : accessKeys.data?.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={3}
                    className="h-40 text-center text-muted-foreground"
                  >
                    <div className="mx-auto flex max-w-xs flex-col items-center gap-2">
                      <KeyRound className="size-5" />
                      <p className="font-medium text-foreground">
                        No client keys
                      </p>
                      <p>Create a key to connect an app.</p>
                    </div>
                  </TableCell>
                </TableRow>
              ) : (
                accessKeys.data?.map((accessKey) => (
                  <TableRow
                    className={
                      accessKey.revoked_at_ms === null
                        ? undefined
                        : "text-muted-foreground"
                    }
                    key={accessKey.id}
                  >
                    <TableCell className="whitespace-normal py-3">
                      <div className="min-w-0 space-y-1">
                        <p className="break-words font-medium text-foreground">
                          {accessKey.name}
                        </p>
                        <p className="font-mono text-xs text-muted-foreground">
                          {accessKey.prefix}…
                        </p>
                      </div>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      <time
                        dateTime={new Date(
                          accessKey.created_at_ms,
                        ).toISOString()}
                      >
                        {formatCreatedAt(accessKey.created_at_ms)}
                      </time>
                    </TableCell>
                    <TableCell className="text-right">
                      {accessKey.revoked_at_ms === null ? (
                        <RevokeAccessKeyDialog record={accessKey} />
                      ) : (
                        <Badge variant="outline">Revoked</Badge>
                      )}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
