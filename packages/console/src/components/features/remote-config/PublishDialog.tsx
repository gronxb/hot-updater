import { AlertTriangle, Loader2, Upload } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
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
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { usePublishRemoteConfigMutation } from "@/lib/remote-config-api";
import {
  type RemoteConfigTemplate,
  summarizeChanges,
  type TemplateChanges,
} from "@/lib/remote-config-draft";
import type { ConsolePublishResult } from "@/lib/remote-config-rpc";

function ChangeList({
  label,
  changes,
}: {
  readonly label: string;
  readonly changes: TemplateChanges;
}) {
  const rows = [
    ["Added", changes.added],
    ["Changed", changes.changed],
    ["Removed", changes.removed],
  ] as const;
  if (rows.every(([, keys]) => keys.length === 0)) return null;
  return (
    <div>
      <p className="text-xs font-medium">{label}</p>
      <dl className="mt-1 grid grid-cols-[5rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        {rows.map(([title, keys]) =>
          keys.length === 0 ? null : (
            <div className="contents" key={title}>
              <dt className="text-muted-foreground">{title}</dt>
              <dd className="min-w-0 break-words font-mono">
                {keys.join(", ")}
              </dd>
            </div>
          ),
        )}
      </dl>
    </div>
  );
}

/** Publishes the draft as the next version, after a summary of what changes. */
export function PublishDialog({
  open,
  onOpenChange,
  base,
  baseVersion,
  draft,
  onPublished,
  onLoadLatest,
  onPublishOver,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The template the draft started from. */
  readonly base: RemoteConfigTemplate;
  readonly baseVersion: number;
  readonly draft: RemoteConfigTemplate;
  readonly onPublished: () => void;
  /** Drops the draft for the version someone else published. */
  readonly onLoadLatest: () => void;
  /** Keeps the draft and publishes it after `version`. */
  readonly onPublishOver: (version: number) => void;
}) {
  const id = useId();
  const publish = usePublishRemoteConfigMutation();
  const [description, setDescription] = useState("");
  const [result, setResult] = useState<ConsolePublishResult | null>(null);
  const changes = summarizeChanges(base, draft);
  const tooLong = description.trim().length > 256;

  const close = (next: boolean) => {
    if (publish.isPending) return;
    onOpenChange(next);
    if (!next) {
      setResult(null);
      publish.reset();
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (tooLong) return;
    try {
      const outcome = await publish.mutateAsync({
        template: draft,
        baseVersion,
        ...(description.trim().length === 0
          ? {}
          : { description: description.trim() }),
      });
      setResult(outcome);
      if (outcome.status === "published") {
        toast.success(`Published version ${outcome.version.version}`);
        setDescription("");
        setResult(null);
        onOpenChange(false);
        onPublished();
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Unable to publish",
      );
    }
  };

  return (
    <Dialog onOpenChange={close} open={open}>
      <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-lg">
        <form className="flex flex-col gap-4" noValidate onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Publish changes</DialogTitle>
            <DialogDescription>
              This becomes version {baseVersion + 1}. Devices get its values on
              their next fetch; earlier versions stay available to roll back
              to.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3 rounded-lg border p-3">
            <ChangeList changes={changes.parameters} label="Parameters" />
            <ChangeList changes={changes.conditions} label="Conditions" />
            {changes.reordered ? (
              <p className="text-xs text-muted-foreground">
                Condition priority changed.
              </p>
            ) : null}
          </div>
          {result?.status === "invalid" ? (
            <Alert variant="destructive">
              <AlertTriangle />
              <AlertTitle>The server refused the template</AlertTitle>
              <AlertDescription>
                <ul className="list-disc pl-4">
                  {result.issues.slice(0, 6).map((issue) => (
                    <li key={`${issue.path}:${issue.message}`}>
                      {issue.path === "" ? "" : `${issue.path}: `}
                      {issue.message}
                    </li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          ) : null}
          {result?.status === "conflict" ? (
            <Alert>
              <AlertTriangle />
              <AlertTitle>
                Version {result.currentVersion} was published while you edited
              </AlertTitle>
              <AlertDescription>
                Load it to review what changed, or publish yours after it,
                replacing its values.
              </AlertDescription>
              <div className="col-span-full mt-2 flex flex-wrap gap-2">
                <Button
                  onClick={() => {
                    close(false);
                    onLoadLatest();
                  }}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Load version {result.currentVersion}
                </Button>
                <Button
                  onClick={() => {
                    onPublishOver(result.currentVersion);
                    setResult(null);
                  }}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  Publish mine after it
                </Button>
              </div>
            </Alert>
          ) : null}
          <Field data-invalid={tooLong || undefined}>
            <FieldLabel htmlFor={`${id}-description`}>Description</FieldLabel>
            <Input
              autoComplete="off"
              className="min-h-11 sm:min-h-9"
              id={`${id}-description`}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="What changed and why"
              value={description}
            />
            <FieldDescription>Shown in the version history.</FieldDescription>
            <FieldError>
              {tooLong ? "Use 256 characters or fewer." : null}
            </FieldError>
          </Field>
          <DialogFooter>
            <Button
              disabled={publish.isPending}
              onClick={() => close(false)}
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              disabled={publish.isPending || result?.status === "conflict"}
              type="submit"
            >
              {publish.isPending ? (
                <Loader2 className="animate-spin" data-icon="inline-start" />
              ) : (
                <Upload data-icon="inline-start" />
              )}
              Publish version {baseVersion + 1}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
