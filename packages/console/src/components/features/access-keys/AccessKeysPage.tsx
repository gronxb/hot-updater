import {
  Check,
  Clipboard,
  KeyRound,
  Loader2,
  Plus,
  ShieldOff,
} from "lucide-react";
import { type FormEvent, type MouseEvent, useState } from "react";
import { toast } from "sonner";

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
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  useCreateManagedAccessKeyMutation,
  useManagedAccessKeysQuery,
  useRevokeManagedAccessKeyMutation,
} from "@/lib/access-keys-api";
import type { ManagedAccessKeyView } from "@/lib/access-keys-rpc";

const formatCreatedAt = (createdAt: number): string =>
  new Date(createdAt).toISOString().slice(0, 10);

function CreateAccessKeyDialog() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [apiKey, setApiKey] = useState<string | null>(null);
  const create = useCreateManagedAccessKeyMutation();
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

function RevokeAccessKeyDialog({ record }: { record: ManagedAccessKeyView }) {
  const [open, setOpen] = useState(false);
  const revoke = useRevokeManagedAccessKeyMutation();

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
      <AlertDialogTrigger asChild>
        <Button size="sm" variant="ghost">
          <ShieldOff data-icon="inline-start" />
          Revoke
        </Button>
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
  const accessKeys = useManagedAccessKeysQuery();

  return (
    <Card>
      <CardHeader className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 space-y-0">
        <CardTitle>Client access keys</CardTitle>
        <CardDescription>
          Keys allow OTA reads and analytics writes. They cannot read analytics
          or manage bundles and keys.
        </CardDescription>
        <CardAction>
          <CreateAccessKeyDialog />
        </CardAction>
      </CardHeader>
      <CardContent>
        {accessKeys.isError ? (
          <p className="text-sm text-destructive" role="alert">
            {accessKeys.error.message}
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Key</TableHead>
                <TableHead>Permissions</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {accessKeys.isLoading ? (
                <TableRow>
                  <TableCell colSpan={5} className="h-24 text-center">
                    <Loader2 className="mx-auto animate-spin" />
                    <span className="sr-only">Loading access keys</span>
                  </TableCell>
                </TableRow>
              ) : accessKeys.data?.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={5}
                    className="h-24 text-center text-muted-foreground"
                  >
                    No access keys yet.
                  </TableCell>
                </TableRow>
              ) : (
                accessKeys.data?.map((accessKey) => (
                  <TableRow key={accessKey.id}>
                    <TableCell className="font-medium">
                      {accessKey.name}
                    </TableCell>
                    <TableCell className="font-mono">
                      {accessKey.prefix}…
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        <Badge variant="secondary">OTA read</Badge>
                        <Badge variant="secondary">Analytics write</Badge>
                      </div>
                    </TableCell>
                    <TableCell>
                      <time
                        dateTime={new Date(accessKey.createdAt).toISOString()}
                      >
                        {formatCreatedAt(accessKey.createdAt)}
                      </time>
                    </TableCell>
                    <TableCell className="text-right">
                      {accessKey.enabled && accessKey.revokedAt === null ? (
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
