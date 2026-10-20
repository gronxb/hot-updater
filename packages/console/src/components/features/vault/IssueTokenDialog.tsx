import type { VaultSecret, VaultSecretKind } from "@hot-updater/server/plugins";
import {
  AlertTriangle,
  Check,
  Clipboard,
  KeyRound,
  Loader2,
} from "lucide-react";
import type * as React from "react";
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
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import { useIssueVaultTokenMutation } from "@/lib/vault-api";
import { VAULT_SECRET_KIND_IDS, vaultSecretKinds } from "@/lib/vault-secrets";

const DAY_MS = 24 * 60 * 60 * 1000;

const EXPIRY_OPTIONS = {
  "30": "30 days",
  "90": "90 days",
  "365": "1 year",
  never: "Never",
} as const;

type Expiry = keyof typeof EXPIRY_OPTIONS;

/**
 * The kinds a read token can reach: the vault never returns a bundle signing
 * key's value, so a scope naming one would read nothing.
 */
const READABLE_KINDS = VAULT_SECRET_KIND_IDS.filter(
  (kind) => kind !== "bundle-signing-key",
);

/** A multi-select chip: checked and tinted while pressed, so the state never rests on shade alone. */
function ScopeToggle({
  className,
  children,
  ...props
}: React.ComponentProps<typeof ToggleGroupItem>) {
  return (
    <ToggleGroupItem
      className={cn(
        "aria-pressed:border-primary/60 aria-pressed:bg-primary/10 aria-pressed:text-foreground",
        className,
      )}
      {...props}
    >
      <Check
        aria-hidden="true"
        className="hidden size-3.5 text-primary group-aria-pressed/toggle:block"
      />
      {children}
    </ToggleGroupItem>
  );
}

/** The two variables CI sets to reach this console's vault. */
export const vaultCiSnippet = (origin: string, token: string) =>
  `HOT_UPDATER_CONSOLE_URL=${origin}\nHOT_UPDATER_VAULT_TOKEN=${token}`;

const copy = async (text: string, what: string) => {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${what} copied`);
  } catch {
    toast.error(`Unable to copy the ${what.toLowerCase()}`);
  }
};

/**
 * Issues a vault token for CI: a name, the secrets it reads by name or
 * kind, and an expiry. The plaintext token shows once.
 */
export function IssueTokenDialog({
  secrets,
  open,
  onOpenChange,
}: {
  readonly secrets: readonly VaultSecret[];
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const [issued, setIssued] = useState<string | null>(null);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) setIssued(null);
      }}
    >
      <DialogContent
        className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-lg"
        showCloseButton={issued === null}
      >
        {!open ? null : issued === null ? (
          <IssueTokenForm onIssued={setIssued} secrets={secrets} />
        ) : (
          <IssuedToken
            onDone={() => {
              onOpenChange(false);
              setIssued(null);
            }}
            token={issued}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function IssueTokenForm({
  secrets,
  onIssued,
}: {
  readonly secrets: readonly VaultSecret[];
  readonly onIssued: (token: string) => void;
}) {
  const id = useId();
  const issue = useIssueVaultTokenMutation();
  const [name, setName] = useState("");
  const [names, setNames] = useState<string[]>([]);
  const [kinds, setKinds] = useState<VaultSecretKind[]>([]);
  const [expiry, setExpiry] = useState<Expiry>("90");
  const [submitted, setSubmitted] = useState(false);

  const readable = secrets.filter(({ kind }) => kind !== "bundle-signing-key");
  const trimmedName = name.trim();
  const errors = {
    name:
      trimmedName.length === 0
        ? "Name the CI job or environment that will use the token."
        : trimmedName.length > 64
          ? "Name must be 64 characters or fewer."
          : undefined,
    scope:
      names.length + kinds.length === 0
        ? "Choose at least one secret or kind."
        : undefined,
  };
  const invalid = Object.values(errors).some((error) => error !== undefined);
  const shown = (message: string | undefined) =>
    submitted ? message : undefined;

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitted(true);
    if (invalid) return;
    try {
      const result = await issue.mutateAsync({
        name: trimmedName,
        scope: {
          secrets: {
            ...(names.length > 0 ? { names } : {}),
            ...(kinds.length > 0 ? { kinds } : {}),
          },
          // Reading values is the one action the console serves tokens.
          actions: ["read"],
        },
        ...(expiry === "never"
          ? {}
          : { expiresAtMs: Date.now() + Number(expiry) * DAY_MS }),
      });
      onIssued(result.token);
      toast.success("Vault token issued");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Unable to issue the token",
      );
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Issue vault token</DialogTitle>
        <DialogDescription>
          CI reads the secrets in the token's scope from this console, and
          nothing else.
        </DialogDescription>
      </DialogHeader>
      <form noValidate onSubmit={handleSubmit}>
        <FieldGroup>
          <Field data-invalid={shown(errors.name) ? true : undefined}>
            <FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
            <Input
              autoComplete="off"
              className="h-11 sm:h-9"
              id={`${id}-name`}
              maxLength={65}
              onChange={(event) => setName(event.target.value)}
              placeholder="GitHub Actions iOS release"
              value={name}
            />
            <FieldError>{shown(errors.name)}</FieldError>
          </Field>

          <FieldSet data-invalid={shown(errors.scope) ? true : undefined}>
            <FieldLegend variant="label">Secrets</FieldLegend>
            <FieldDescription>
              A kind covers every secret of it, including ones added later.
            </FieldDescription>
            <div className="flex flex-col gap-3">
              {readable.length > 0 ? (
                <div className="flex flex-col gap-1.5">
                  <p className="text-xs text-muted-foreground">By name</p>
                  <ToggleGroup
                    aria-label="Secrets by name"
                    className="flex-wrap"
                    multiple
                    onValueChange={(values) => setNames(values as string[])}
                    spacing={1}
                    value={names}
                    variant="outline"
                  >
                    {readable.map((secret) => (
                      <ScopeToggle
                        className="min-h-11 px-2.5 font-mono sm:min-h-8"
                        key={secret.id}
                        value={secret.name}
                      >
                        {secret.name}
                      </ScopeToggle>
                    ))}
                  </ToggleGroup>
                </div>
              ) : null}
              <div className="flex flex-col gap-1.5">
                <p className="text-xs text-muted-foreground">By kind</p>
                <ToggleGroup
                  aria-label="Secrets by kind"
                  className="flex-wrap"
                  multiple
                  onValueChange={(values) =>
                    setKinds(values as VaultSecretKind[])
                  }
                  spacing={1}
                  value={kinds}
                  variant="outline"
                >
                  {READABLE_KINDS.map((kind) => (
                    <ScopeToggle
                      className="min-h-11 px-2.5 sm:min-h-8"
                      key={kind}
                      value={kind}
                    >
                      {vaultSecretKinds[kind].label}
                    </ScopeToggle>
                  ))}
                </ToggleGroup>
              </div>
            </div>
            <FieldError>{shown(errors.scope)}</FieldError>
          </FieldSet>

          <Field>
            <FieldLabel htmlFor={`${id}-expiry`}>Expires</FieldLabel>
            <Select
              items={EXPIRY_OPTIONS}
              onValueChange={(next) => {
                if (next !== null) setExpiry(next as Expiry);
              }}
              value={expiry}
            >
              <SelectTrigger
                className="min-h-11 w-full sm:min-h-9"
                id={`${id}-expiry`}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {(Object.keys(EXPIRY_OPTIONS) as Expiry[]).map((option) => (
                    <SelectItem key={option} value={option}>
                      {EXPIRY_OPTIONS[option]}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
        </FieldGroup>
        <DialogFooter className="mt-4">
          <Button
            className="min-h-11 sm:min-h-8"
            disabled={issue.isPending || (submitted && invalid)}
            type="submit"
          >
            {issue.isPending ? (
              <Loader2
                className="motion-safe:animate-spin"
                data-icon="inline-start"
              />
            ) : (
              <KeyRound data-icon="inline-start" />
            )}
            Issue token
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}

function IssuedToken({
  token,
  onDone,
}: {
  readonly token: string;
  readonly onDone: () => void;
}) {
  const id = useId();
  const snippet = vaultCiSnippet(window.location.origin, token);
  return (
    <>
      <DialogHeader>
        <DialogTitle>Save your vault token</DialogTitle>
        <DialogDescription>
          Add it to your CI secrets now. The console stores only its digest and
          can't show it again.
        </DialogDescription>
      </DialogHeader>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor={`${id}-token`}>Vault token</FieldLabel>
          <div className="flex gap-2">
            <Input
              className="h-11 font-mono sm:h-9"
              id={`${id}-token`}
              onFocus={(event) => event.currentTarget.select()}
              readOnly
              value={token}
            />
            <Button
              className="min-h-11 sm:min-h-9"
              onClick={() => void copy(token, "Token")}
              type="button"
              variant="outline"
            >
              <Clipboard data-icon="inline-start" />
              Copy
            </Button>
          </div>
        </Field>
        <Field>
          <div className="flex items-center justify-between gap-2">
            <FieldLabel htmlFor={`${id}-ci`}>CI environment</FieldLabel>
            <Button
              className="min-h-11 sm:min-h-7"
              onClick={() => void copy(snippet, "CI variables")}
              size="xs"
              type="button"
              variant="ghost"
            >
              <Clipboard data-icon="inline-start" />
              Copy
            </Button>
          </div>
          <pre
            className="rounded-md border bg-muted/40 px-3 py-2 font-mono text-xs break-all whitespace-pre-wrap"
            id={`${id}-ci`}
          >
            {snippet}
          </pre>
          <FieldDescription>
            Store both as CI secrets: the console's address and the token its
            vault routes take as a Bearer token.
          </FieldDescription>
        </Field>
        <Alert>
          <AlertTriangle />
          <AlertTitle>Shown once</AlertTitle>
          <AlertDescription>
            If you lose it, revoke it and issue another.
          </AlertDescription>
        </Alert>
        <DialogFooter>
          <Button className="min-h-11 sm:min-h-8" onClick={onDone}>
            <Check data-icon="inline-start" />
            Done
          </Button>
        </DialogFooter>
      </FieldGroup>
    </>
  );
}
