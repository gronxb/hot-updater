import type { VaultSecret, VaultSecretKind } from "@hot-updater/server/plugins";
import {
  AlertTriangle,
  FileUp,
  Loader2,
  Plus,
  Save,
  Trash2,
} from "lucide-react";
import { type FormEvent, useId, useRef, useState } from "react";
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
import { usePutVaultSecretMutation } from "@/lib/vault-api";
import {
  ascKeyIdFromFileName,
  buildVaultValue,
  fileToBase64,
  VAULT_SECRET_KIND_IDS,
  VAULT_SECRET_NAME_PATTERN,
  VAULT_VALUE_LIMIT_BYTES,
  VAULT_VARIABLE_NAME_PATTERN,
  type VaultSecretField,
  vaultSecretKinds,
  type VaultVariable,
  vaultValueBytes,
  variablesSetElsewhere,
} from "@/lib/vault-secrets";

/** A label inside a sentence: "Issuer ID" as "issuer ID", keeping acronyms. */
const inSentence = (label: string) =>
  /^[A-Z][a-z]/u.test(label) ? label[0]!.toLowerCase() + label.slice(1) : label;

/**
 * The largest file a secret can hold: base64 grows bytes by a third, so a
 * larger file can't fit the value limit and isn't read at all.
 */
const MAX_FILE_BYTES = Math.floor((VAULT_VALUE_LIMIT_BYTES * 3) / 4);

const formatBytes = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;

/** The variable rows a key/value secret's form starts with: its names, values empty. */
const variablesOf = (secret: VaultSecret | undefined): VaultVariable[] => {
  const names = secret?.metadata.variables;
  return Array.isArray(names) && names.length > 0
    ? names.map((name) => ({ name: String(name), value: "" }))
    : [{ name: "", value: "" }];
};

interface FormErrors {
  readonly name?: string;
  readonly fields: Readonly<Record<string, string>>;
  readonly variables?: string;
  readonly size?: string;
}

/**
 * Adds a secret, or with `secret` stores a new version of one. Values are
 * write-only: the form starts empty and the console never shows them again.
 */
export function SecretDialog({
  secret,
  secrets,
  open,
  onOpenChange,
}: {
  readonly secret?: VaultSecret;
  /** The vault's secrets, which a new name and its variables are checked against. */
  readonly secrets: readonly VaultSecret[];
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-lg">
        {open ? (
          <SecretForm
            // A secret removed and stored again under its name, as another
            // kind, starts a new form for its fields.
            key={secret === undefined ? "new" : `${secret.id}:${secret.kind}`}
            onDone={() => onOpenChange(false)}
            secret={secret}
            secrets={secrets}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function SecretForm({
  secret,
  secrets,
  onDone,
}: {
  readonly secret?: VaultSecret;
  readonly secrets: readonly VaultSecret[];
  readonly onDone: () => void;
}) {
  const id = useId();
  const put = usePutVaultSecretMutation();
  const [kind, setKind] = useState<VaultSecretKind>(
    secret?.kind ?? "asc-api-key",
  );
  // A new secret is named after its kind, which the CLI looks up by default.
  const [name, setName] = useState<string | null>(secret?.name ?? null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [files, setFiles] = useState<
    Record<string, { readonly name: string; readonly size: number }>
  >({});
  const [variables, setVariables] = useState(() => variablesOf(secret));
  // The file last chosen for each field: a read that finishes after another
  // choice, or a kind change, is dropped.
  const chosen = useRef<Partial<Record<string, File>>>({});
  // The key ID the last .p8 file name filled in: a new file replaces it,
  // and leaves one the user typed alone.
  const filledKeyId = useRef<string | undefined>(undefined);
  const [submitted, setSubmitted] = useState(false);

  const kindUi = vaultSecretKinds[kind];
  const secretName = (name ?? kind).trim();
  const value = buildVaultValue(kind, { fields, variables });
  const bytes = vaultValueBytes(value);

  const errors: FormErrors = {
    name:
      secret !== undefined
        ? undefined
        : !VAULT_SECRET_NAME_PATTERN.test(secretName)
          ? "Use 1-64 letters, digits, dots, dashes, or underscores, starting with a letter or digit."
          : secrets.some(({ name: existing }) => existing === secretName)
            ? `A secret is already named ${secretName}. Overwrite it from its row instead.`
            : undefined,
    fields: Object.fromEntries(
      (kindUi.fields ?? []).flatMap(({ key, label, type }) =>
        (type === "password" ? fields[key] : fields[key]?.trim())
          ? []
          : [
              [
                key,
                type === "file"
                  ? `Choose the ${inSentence(label)}.`
                  : `Enter the ${inSentence(label)}.`,
              ],
            ],
      ),
    ),
    variables:
      kindUi.fields !== null
        ? undefined
        : Object.keys(value).length === 0
          ? "Add at least one variable."
          : variables.some(
                ({ name: variable, value: entry }) =>
                  (variable.trim() !== "" || entry !== "") &&
                  !VAULT_VARIABLE_NAME_PATTERN.test(variable.trim()),
              )
            ? "Name variables with letters, digits, and underscores, not starting with a digit."
            : new Set(
                  variables
                    .map(({ name: variable }) => variable.trim())
                    .filter(Boolean),
                ).size !==
                variables.filter(({ name: variable }) => variable.trim()).length
              ? "Each variable name appears once."
              : undefined,
    size:
      bytes > VAULT_VALUE_LIMIT_BYTES
        ? `This is ${formatBytes(bytes)} once encoded; a secret holds up to 64 KB.`
        : undefined,
  };
  // Not an error: secrets behind separately scoped tokens, such as one per
  // environment, may set the same variable.
  const setElsewhere =
    kindUi.fields === null
      ? variablesSetElsewhere(secrets, secretName, Object.keys(value))
      : [];
  const invalid =
    errors.name !== undefined ||
    Object.keys(errors.fields).length > 0 ||
    errors.variables !== undefined ||
    errors.size !== undefined;

  const chooseKind = (next: VaultSecretKind) => {
    setKind(next);
    setFields({});
    setFiles({});
    chosen.current = {};
    filledKeyId.current = undefined;
    setVariables(variablesOf(undefined));
    setSubmitted(false);
  };

  const chooseFile = async (
    field: VaultSecretField,
    file: File | undefined,
  ) => {
    if (file === undefined) return;
    chosen.current[field.key] = file;
    setFiles((current) => ({
      ...current,
      [field.key]: { name: file.name, size: file.size },
    }));
    // The previous file's bytes leave at once, so nothing saves them under
    // this file's name while it is read.
    setFields((current) => ({ ...current, [field.key]: "" }));
    if (file.size > MAX_FILE_BYTES) return;
    const base64 = await fileToBase64(file);
    if (chosen.current[field.key] !== file) return;
    // AuthKey_<key ID>.p8 names its key ID; another name clears the one an
    // earlier file filled in.
    const keyId = ascKeyIdFromFileName(file.name);
    setFields((current) => {
      const typed =
        current.keyId?.trim() && current.keyId !== filledKeyId.current;
      if (kind !== "asc-api-key" || typed) {
        return { ...current, [field.key]: base64 };
      }
      filledKeyId.current = keyId;
      return { ...current, [field.key]: base64, keyId: keyId ?? "" };
    });
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitted(true);
    if (invalid) return;
    try {
      const saved = await put.mutateAsync({
        name: secretName,
        kind,
        value,
        expectedVersion: secret?.version ?? 0,
      });
      toast.success(
        secret === undefined
          ? `${saved.name} saved`
          : `${saved.name} is now version ${saved.version}`,
      );
      onDone();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Unable to save the secret",
      );
    }
  };

  const shown = (message: string | undefined) =>
    submitted ? message : undefined;

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {secret === undefined ? "Add secret" : `Overwrite ${secret.name}`}
        </DialogTitle>
        <DialogDescription>
          {secret === undefined
            ? "Values are encrypted with the console's master key. No one can view them here after you save."
            : `Saves version ${secret.version + 1}. Enter every value again: the console never shows the current ones.`}
        </DialogDescription>
      </DialogHeader>
      <form noValidate onSubmit={handleSubmit}>
        <FieldGroup>
          {secret === undefined ? (
            <>
              <Field>
                <FieldLabel htmlFor={`${id}-kind`}>Kind</FieldLabel>
                <Select
                  items={Object.fromEntries(
                    VAULT_SECRET_KIND_IDS.map((each) => [
                      each,
                      vaultSecretKinds[each].label,
                    ]),
                  )}
                  onValueChange={(next) => {
                    if (next !== null) chooseKind(next as VaultSecretKind);
                  }}
                  value={kind}
                >
                  <SelectTrigger
                    className="min-h-11 w-full sm:min-h-9"
                    id={`${id}-kind`}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {VAULT_SECRET_KIND_IDS.map((each) => (
                        <SelectItem key={each} value={each}>
                          {vaultSecretKinds[each].label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <FieldDescription>{kindUi.description}</FieldDescription>
              </Field>
              <Field data-invalid={shown(errors.name) ? true : undefined}>
                <FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
                <Input
                  autoComplete="off"
                  className="h-11 font-mono sm:h-9"
                  id={`${id}-name`}
                  maxLength={64}
                  onChange={(event) => setName(event.target.value)}
                  spellCheck={false}
                  value={name ?? kind}
                />
                <FieldDescription>
                  The CLI looks a credential up by its kind unless your config
                  names another secret, such as{" "}
                  <code className="font-mono">widget-keystore</code>.
                </FieldDescription>
                <FieldError>{shown(errors.name)}</FieldError>
              </Field>
            </>
          ) : null}

          {kindUi.fields === null ? (
            <>
              <VariablesFieldSet
                error={shown(errors.variables)}
                onChange={setVariables}
                variables={variables}
              />
              {setElsewhere.length > 0 ? (
                <Alert>
                  <AlertTriangle />
                  <AlertTitle>Already set by another secret</AlertTitle>
                  <AlertDescription>
                    <ul>
                      {setElsewhere.map(({ variable, secret: other }) => (
                        <li key={`${variable}:${other.name}`}>
                          <code className="font-mono">{variable}</code> is in{" "}
                          <span className="font-medium text-foreground">
                            {other.name}
                          </span>{" "}
                          ({vaultSecretKinds[other.kind].label})
                        </li>
                      ))}
                    </ul>
                    <p>
                      If one vault token reaches both secrets, the CLI refuses
                      the variable. Keep each variable in one secret, or reach
                      the two with separate tokens.
                    </p>
                  </AlertDescription>
                </Alert>
              ) : null}
            </>
          ) : (
            kindUi.fields.map((field) => {
              const file = files[field.key];
              const error =
                file !== undefined && file.size > MAX_FILE_BYTES
                  ? `This file is ${formatBytes(file.size)}; a secret holds files up to ${formatBytes(MAX_FILE_BYTES)}.`
                  : shown(errors.fields[field.key]);
              const inputId = `${id}-${field.key}`;
              return (
                <Field data-invalid={error ? true : undefined} key={field.key}>
                  <FieldLabel htmlFor={inputId}>{field.label}</FieldLabel>
                  {field.type === "file" ? (
                    <label
                      className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md border border-dashed border-input px-3 py-2 text-xs transition-colors hover:bg-muted/50 focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50 sm:min-h-9"
                      htmlFor={inputId}
                    >
                      <FileUp
                        aria-hidden="true"
                        className="size-3.5 shrink-0 text-muted-foreground"
                      />
                      {files[field.key] === undefined ? (
                        <span className="text-muted-foreground">
                          Choose a file
                        </span>
                      ) : (
                        <span className="flex min-w-0 flex-1 items-center justify-between gap-2">
                          <span className="truncate font-mono">
                            {files[field.key]?.name}
                          </span>
                          <span className="shrink-0 tabular-nums text-muted-foreground">
                            {formatBytes(files[field.key]?.size ?? 0)}
                          </span>
                        </span>
                      )}
                      <input
                        accept={field.accept}
                        className="sr-only"
                        id={inputId}
                        onChange={(event) =>
                          void chooseFile(field, event.target.files?.[0])
                        }
                        type="file"
                      />
                    </label>
                  ) : (
                    <Input
                      autoComplete={
                        field.type === "password" ? "new-password" : "off"
                      }
                      className="h-11 sm:h-9"
                      id={inputId}
                      onChange={(event) =>
                        setFields((current) => ({
                          ...current,
                          [field.key]: event.target.value,
                        }))
                      }
                      placeholder={field.placeholder}
                      spellCheck={false}
                      type={field.type}
                      value={fields[field.key] ?? ""}
                    />
                  )}
                  {field.description ? (
                    <FieldDescription>{field.description}</FieldDescription>
                  ) : null}
                  <FieldError>{error}</FieldError>
                </Field>
              );
            })
          )}
          {errors.size ? (
            <p className="text-xs text-destructive" role="alert">
              {errors.size}
            </p>
          ) : null}
        </FieldGroup>
        <DialogFooter className="mt-4">
          <Button
            className="min-h-11 sm:min-h-8"
            disabled={put.isPending || (submitted && invalid)}
            type="submit"
          >
            {put.isPending ? (
              <Loader2
                className="motion-safe:animate-spin"
                data-icon="inline-start"
              />
            ) : (
              <Save data-icon="inline-start" />
            )}
            {secret === undefined ? "Save secret" : "Save new version"}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}

function VariablesFieldSet({
  variables,
  onChange,
  error,
}: {
  readonly variables: readonly VaultVariable[];
  readonly onChange: (variables: VaultVariable[]) => void;
  readonly error: string | undefined;
}) {
  const id = useId();
  const update = (index: number, next: Partial<VaultVariable>) =>
    onChange(
      variables.map((variable, each) =>
        each === index ? { ...variable, ...next } : variable,
      ),
    );
  return (
    <FieldSet data-invalid={error ? true : undefined}>
      <FieldLegend variant="label">Variables</FieldLegend>
      <FieldDescription>
        Environment variable names and their values, such as{" "}
        <code className="font-mono">HOT_UPDATER_S3_SECRET</code>.
      </FieldDescription>
      <div className="flex flex-col gap-2">
        {variables.map((variable, index) => (
          <div
            className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-2"
            key={index}
          >
            <Input
              aria-label={`Variable ${index + 1} name`}
              autoComplete="off"
              className="h-11 font-mono sm:h-9"
              id={`${id}-${index}-name`}
              onChange={(event) => update(index, { name: event.target.value })}
              placeholder="NAME"
              spellCheck={false}
              value={variable.name}
            />
            <Input
              aria-label={`Variable ${index + 1} value`}
              autoComplete="new-password"
              className="h-11 sm:h-9"
              onChange={(event) => update(index, { value: event.target.value })}
              placeholder="Value"
              spellCheck={false}
              type="password"
              value={variable.value}
            />
            <Button
              aria-label={`Remove variable ${index + 1}`}
              className="size-11 sm:size-8"
              disabled={variables.length === 1}
              onClick={() =>
                onChange(variables.filter((_, each) => each !== index))
              }
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              <Trash2 aria-hidden="true" />
            </Button>
          </div>
        ))}
      </div>
      <Button
        className="min-h-11 w-fit sm:min-h-8"
        onClick={() => onChange([...variables, { name: "", value: "" }])}
        size="sm"
        type="button"
        variant="outline"
      >
        <Plus data-icon="inline-start" />
        Add variable
      </Button>
      <FieldError>{error}</FieldError>
    </FieldSet>
  );
}
