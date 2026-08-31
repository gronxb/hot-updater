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
  useApiKeysQuery,
  useCreateApiKeyMutation,
  useRevokeApiKeyMutation,
} from "@/lib/api-keys-api";
import type { ApiKeyView } from "@/lib/api-keys-rpc";

const formatCreatedAt = (createdAt: number): string =>
  new Date(createdAt).toISOString().slice(0, 10);

function CreateApiKeyDialog() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [apiKey, setApiKey] = useState<string | null>(null);
  const create = useCreateApiKeyMutation();
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
      toast.success("API key created");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Unable to create API key",
      );
    }
  };

  const copyKey = async () => {
    if (apiKey === null) return;
    try {
      await navigator.clipboard.writeText(apiKey);
      toast.success("API key copied");
    } catch {
      toast.error("Unable to copy API key");
    }
  };

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus data-icon="inline-start" />
        Create API key
      </Button>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent showCloseButton={apiKey === null}>
          <DialogHeader>
            <DialogTitle>
              {apiKey === null ? "Create API key" : "Save your API key"}
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
                  <FieldLabel htmlFor="api-key-name">Name</FieldLabel>
                  <Input
                    id="api-key-name"
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
                  Create API key
                </Button>
              </DialogFooter>
            </form>
          ) : (
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="created-api-key">API key</FieldLabel>
                <div className="flex gap-2">
                  <Input
                    id="created-api-key"
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

function RevokeApiKeyDialog({ record }: { record: ApiKeyView }) {
  const [open, setOpen] = useState(false);
  const revoke = useRevokeApiKeyMutation();

  const handleRevoke = async (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    try {
      await revoke.mutateAsync(record.id);
      setOpen(false);
      toast.success("API key revoked");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Unable to revoke API key",
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
            insights access. This action cannot be undone.
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
            Revoke API key
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function ApiKeysPage() {
  const apiKeys = useApiKeysQuery();

  return (
    <Card className="overflow-hidden shadow-sm">
      <CardHeader className="flex-row items-center justify-between space-y-0 border-b px-4 py-3">
        <CardTitle className="text-sm">
          <h2>API keys</h2>
        </CardTitle>
        <CreateApiKeyDialog />
      </CardHeader>
      <CardContent className="p-0">
        {apiKeys.isError ? (
          <div className="p-4">
            <Alert variant="destructive">
              <AlertTriangle />
              <AlertTitle>API keys couldn't be loaded</AlertTitle>
              <AlertDescription>
                Check your connection and try again.
              </AlertDescription>
              <AlertAction>
                <Button
                  onClick={() => void apiKeys.refetch()}
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
          <Table aria-label="API keys" className="table-fixed">
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
              {apiKeys.isLoading ? (
                Array.from({ length: 3 }, (_, index) => (
                  <TableRow key={index}>
                    <TableCell className="space-y-2 py-3">
                      {index === 0 ? (
                        <span className="sr-only">Loading API keys</span>
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
              ) : apiKeys.data?.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={3}
                    className="h-40 text-center text-muted-foreground"
                  >
                    <div className="mx-auto flex max-w-xs flex-col items-center gap-2">
                      <KeyRound className="size-5" />
                      <p className="font-medium text-foreground">No API keys</p>
                      <p>Create an API key to connect an app.</p>
                    </div>
                  </TableCell>
                </TableRow>
              ) : (
                apiKeys.data?.map((apiKey) => (
                  <TableRow
                    className={
                      apiKey.revoked_at_ms === null
                        ? undefined
                        : "text-muted-foreground"
                    }
                    key={apiKey.id}
                  >
                    <TableCell className="whitespace-normal py-3">
                      <div className="min-w-0 space-y-1">
                        <p className="break-words font-medium text-foreground">
                          {apiKey.name}
                        </p>
                        <p className="font-mono text-xs text-muted-foreground">
                          {apiKey.prefix}…
                        </p>
                      </div>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      <time
                        dateTime={new Date(apiKey.created_at_ms).toISOString()}
                      >
                        {formatCreatedAt(apiKey.created_at_ms)}
                      </time>
                    </TableCell>
                    <TableCell className="text-right">
                      {apiKey.revoked_at_ms === null ? (
                        <RevokeApiKeyDialog record={apiKey} />
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
