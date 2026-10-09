import { Plus, RefreshCw, Trash2, X } from "lucide-react";
import { type FormEvent, useId, useState } from "react";

import { PlatformIcon } from "@/components/PlatformIcon";
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
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useChannelsQuery } from "@/lib/api";
import {
  conditionNameError,
  createRule,
  createSeed,
  endPresets,
  fromLocalDateTimeInput,
  RULE_TYPE_LABELS,
  type RemoteConfigCondition,
  type RemoteConfigRule,
  type RemoteConfigRuleType,
  ruleError,
  splitList,
  startPresets,
  suggestConditionName,
  toLocalDateTimeInput,
} from "@/lib/remote-config-draft";
import { useOpenSession } from "@/lib/use-dialog-target";

import { useDateTimeText } from "./useDateTimeText";

const RULE_TYPES = Object.keys(RULE_TYPE_LABELS) as RemoteConfigRuleType[];

/** A list typed as text, kept as typed until it is saved. */
function ListInput({
  id,
  values,
  onChange,
  placeholder,
  multiline = false,
}: {
  readonly id: string;
  readonly values: readonly string[];
  readonly onChange: (values: string[]) => void;
  readonly placeholder: string;
  readonly multiline?: boolean;
}) {
  const [text, setText] = useState(values.join(", "));
  // A value added outside the input, such as a known channel, shows in it.
  const [shown, setShown] = useState(values);
  if (shown !== values) {
    setShown(values);
    if (splitList(text).join("\n") !== values.join("\n")) {
      setText(values.join(", "));
    }
  }
  const update = (next: string) => {
    setText(next);
    onChange(splitList(next));
  };
  return multiline ? (
    <Textarea
      className="min-h-20 font-mono text-xs"
      id={id}
      onChange={(event) => update(event.target.value)}
      placeholder={placeholder}
      spellCheck={false}
      value={text}
    />
  ) : (
    <Input
      autoComplete="off"
      className="min-h-11 sm:min-h-9"
      id={id}
      onChange={(event) => update(event.target.value)}
      placeholder={placeholder}
      value={text}
    />
  );
}

/** One end of a date and time rule: a picker, a clear button, and quick choices. */
function DateTimeField({
  id,
  label,
  value,
  presets,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: string | undefined;
  readonly presets: readonly { readonly label: string; readonly iso: string }[];
  readonly onChange: (value: string | undefined) => void;
}) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <InputGroup className="h-11 sm:h-9">
        <InputGroupInput
          className="h-11 tabular-nums sm:h-9"
          id={id}
          onChange={(event) =>
            onChange(fromLocalDateTimeInput(event.target.value))
          }
          type="datetime-local"
          value={toLocalDateTimeInput(value)}
        />
        {value === undefined ? null : (
          <InputGroupAddon align="inline-end">
            <InputGroupButton
              aria-label={`Clear ${label.toLowerCase()}`}
              className="size-11 sm:size-5"
              onClick={() => onChange(undefined)}
              size="icon-xs"
            >
              <X />
            </InputGroupButton>
          </InputGroupAddon>
        )}
      </InputGroup>
      <div className="flex flex-wrap gap-1.5">
        {presets.map((preset) => (
          <Button
            aria-pressed={preset.iso === value}
            className="min-h-11 sm:min-h-6"
            key={preset.label}
            onClick={() => onChange(preset.iso)}
            size="xs"
            type="button"
            variant={preset.iso === value ? "secondary" : "outline"}
          >
            {preset.label}
          </Button>
        ))}
      </div>
    </Field>
  );
}

function RuleFields({
  rule,
  onChange,
}: {
  readonly rule: RemoteConfigRule;
  readonly onChange: (rule: RemoteConfigRule) => void;
}) {
  const id = useId();
  const channels = useChannelsQuery();
  switch (rule.type) {
    case "platform":
      return (
        <ToggleGroup
          aria-label="Platforms"
          multiple
          onValueChange={(values) =>
            onChange({
              ...rule,
              platforms: (values as string[]).filter(
                (value): value is "ios" | "android" =>
                  value === "ios" || value === "android",
              ),
            })
          }
          value={[...rule.platforms]}
          variant="outline"
        >
          {(["ios", "android"] as const).map((platform) => (
            <ToggleGroupItem
              className="min-h-11 px-3 sm:min-h-8"
              key={platform}
              value={platform}
            >
              <PlatformIcon className="size-3.5" platform={platform} />
              {platform === "ios" ? "iOS" : "Android"}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      );
    case "channel": {
      const known = (channels.data ?? [])
        .map(({ name }) => name)
        .filter((channel) => !rule.channels.includes(channel));
      return (
        <div className="flex flex-col gap-2">
          <ListInput
            id={`${id}-channels`}
            onChange={(next) => onChange({ ...rule, channels: next })}
            placeholder="production, beta"
            values={rule.channels}
          />
          {known.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted-foreground">Add:</span>
              {known.slice(0, 8).map((channel) => (
                <Button
                  className="min-h-11 sm:min-h-6"
                  key={channel}
                  onClick={() =>
                    onChange({ ...rule, channels: [...rule.channels, channel] })
                  }
                  size="xs"
                  type="button"
                  variant="outline"
                >
                  <Plus data-icon="inline-start" />
                  {channel}
                </Button>
              ))}
            </div>
          ) : null}
        </div>
      );
    }
    case "appVersion":
      return (
        <Input
          aria-label="App version range"
          autoComplete="off"
          className="min-h-11 font-mono sm:min-h-9"
          onChange={(event) => onChange({ ...rule, range: event.target.value })}
          placeholder=">=1.4.0"
          value={rule.range}
        />
      );
    case "cohort":
      return (
        <ListInput
          id={`${id}-cohorts`}
          onChange={(next) => onChange({ ...rule, cohorts: next })}
          placeholder="1, 2, beta-testers"
          values={rule.cohorts}
        />
      );
    case "percent":
      return (
        <div className="grid gap-2 sm:grid-cols-[repeat(2,minmax(0,8rem))_minmax(0,1fr)]">
          <Field>
            <FieldLabel htmlFor={`${id}-from`}>From %</FieldLabel>
            <Input
              className="min-h-11 tabular-nums sm:min-h-9"
              id={`${id}-from`}
              inputMode="decimal"
              max={100}
              min={0}
              onChange={(event) =>
                onChange({ ...rule, from: Number(event.target.value) })
              }
              step={0.1}
              type="number"
              value={rule.from}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-to`}>To %</FieldLabel>
            <Input
              className="min-h-11 tabular-nums sm:min-h-9"
              id={`${id}-to`}
              inputMode="decimal"
              max={100}
              min={0}
              onChange={(event) =>
                onChange({ ...rule, to: Number(event.target.value) })
              }
              step={0.1}
              type="number"
              value={rule.to}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-seed`}>Seed</FieldLabel>
            <div className="flex gap-2">
              <Input
                autoComplete="off"
                className="min-h-11 font-mono sm:min-h-9"
                id={`${id}-seed`}
                onChange={(event) =>
                  onChange({ ...rule, seed: event.target.value })
                }
                value={rule.seed}
              />
              <Button
                aria-label="New seed"
                className="size-11 sm:size-9"
                onClick={() => onChange({ ...rule, seed: createSeed() })}
                size="icon"
                type="button"
                variant="outline"
              >
                <RefreshCw />
              </Button>
            </div>
          </Field>
        </div>
      );
    case "fingerprint":
      return (
        <ListInput
          id={`${id}-hashes`}
          multiline
          onChange={(next) => onChange({ ...rule, hashes: next })}
          placeholder="One fingerprint hash per line"
          values={rule.hashes}
        />
      );
    case "dateTime": {
      const change = (field: "from" | "to", instant: string | undefined) => {
        const { [field]: _previous, ...rest } = rule;
        onChange(instant === undefined ? rest : { ...rest, [field]: instant });
      };
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <DateTimeField
            id={`${id}-from`}
            label="From"
            onChange={(instant) => change("from", instant)}
            presets={startPresets()}
            value={rule.from}
          />
          <DateTimeField
            id={`${id}-until`}
            label="Until"
            onChange={(instant) => change("to", instant)}
            presets={endPresets(rule.from)}
            value={rule.to}
          />
        </div>
      );
    }
  }
}

const RULE_HINTS: Readonly<Record<RemoteConfigRuleType, string>> = {
  platform: "Devices on any of these platforms.",
  channel: "Devices on any of these channels, separated by commas.",
  appVersion:
    "A semver range of native app versions, as release targets use: 2.x, >=1.4.0 <2.0.0.",
  percent:
    "Installs whose numeric cohort lands in this share. Rules with one seed split the same order, so 0–10 and 10–20 never overlap.",
  cohort: "Numeric cohorts from 1 to 1000, or custom cohort names.",
  fingerprint: "Native builds with any of these fingerprints.",
  dateTime:
    "Leave either end empty to keep it open. Devices get the change at their next fetch.",
};

/** Adds or edits a condition: a name and the rules a device must all match. */
export function ConditionDialog({
  open,
  onOpenChange,
  condition,
  takenNames,
  onSave,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The condition to edit, or null for a new one. */
  readonly condition: RemoteConfigCondition | null;
  readonly takenNames: readonly string[];
  readonly onSave: (condition: RemoteConfigCondition) => void;
}) {
  // The form stays while the dialog animates closed, and starts over on
  // each opening.
  const session = useOpenSession(open);
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-xl">
        <ConditionForm
          condition={condition}
          key={session}
          onCancel={() => onOpenChange(false)}
          onSave={(next) => {
            onSave(next);
            onOpenChange(false);
          }}
          takenNames={takenNames}
        />
      </DialogContent>
    </Dialog>
  );
}

function ConditionForm({
  condition,
  takenNames,
  onSave,
  onCancel,
}: {
  readonly condition: RemoteConfigCondition | null;
  readonly takenNames: readonly string[];
  readonly onSave: (condition: RemoteConfigCondition) => void;
  readonly onCancel: () => void;
}) {
  const id = useId();
  const { dateTimeText, timeZone } = useDateTimeText();
  // A condition named after its rules keeps following them: its name starts
  // empty, so it saves as the rules after an edit too.
  const [name, setName] = useState(() =>
    condition === null ||
    condition.name ===
      suggestConditionName(condition.rules, takenNames, dateTimeText)
      ? ""
      : condition.name,
  );
  const [rules, setRules] = useState<RemoteConfigRule[]>(
    condition === null ? [createRule("platform")] : [...condition.rules],
  );
  const [submitted, setSubmitted] = useState(false);
  // An empty name saves as the rules in a few words.
  const suggestedName = suggestConditionName(rules, takenNames, dateTimeText);
  const savedName = name.trim().length === 0 ? suggestedName : name;
  const nameError = conditionNameError(savedName, takenNames);
  const ruleErrors = rules.map(ruleError);
  const unused = RULE_TYPES.filter(
    (type) => !rules.some((rule) => rule.type === type),
  );
  const invalid =
    nameError !== null ||
    rules.length === 0 ||
    ruleErrors.some((error) => error !== null);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // Opened from the parameter dialog, it must not submit that form too.
    event.stopPropagation();
    setSubmitted(true);
    if (invalid) return;
    onSave({
      name: savedName.trim(),
      rules: rules.map((rule) =>
        rule.type === "appVersion"
          ? { ...rule, range: rule.range.trim() }
          : rule,
      ),
    });
  };

  return (
    <form className="flex flex-col gap-4" noValidate onSubmit={submit}>
      <DialogHeader>
        <DialogTitle>
          {condition === null ? "Add condition" : "Edit condition"}
        </DialogTitle>
        <DialogDescription>
          A device matches when it matches every rule.
        </DialogDescription>
      </DialogHeader>
      <FieldGroup>
        <Field data-invalid={(submitted && nameError !== null) || undefined}>
          <FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
          <Input
            autoComplete="off"
            className="min-h-11 sm:min-h-9"
            id={`${id}-name`}
            maxLength={101}
            onChange={(event) => setName(event.target.value)}
            placeholder={suggestedName || "Beta testers on iOS"}
            value={name}
          />
          <FieldDescription>
            Optional: without one, it is named after its rules.
          </FieldDescription>
          <FieldError>{submitted ? nameError : null}</FieldError>
        </Field>
        <FieldSet>
          <FieldLegend variant="label">Rules</FieldLegend>
          {rules.length === 0 ? (
            <FieldError>
              {submitted ? "Add at least one rule." : null}
            </FieldError>
          ) : null}
          <ol className="flex flex-col gap-3">
            {rules.map((rule, index) => (
              <li className="rounded-lg border p-3" key={rule.type}>
                <Field
                  data-invalid={
                    (submitted && ruleErrors[index] !== null) || undefined
                  }
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">
                      {RULE_TYPE_LABELS[rule.type]}
                    </span>
                    <Button
                      aria-label={`Remove the ${RULE_TYPE_LABELS[rule.type].toLowerCase()} rule`}
                      className="size-11 sm:size-7"
                      onClick={() =>
                        setRules(rules.filter((_, at) => at !== index))
                      }
                      size="icon-sm"
                      type="button"
                      variant="ghost"
                    >
                      <Trash2 />
                    </Button>
                  </div>
                  <RuleFields
                    onChange={(next) =>
                      setRules(
                        rules.map((existing, at) =>
                          at === index ? next : existing,
                        ),
                      )
                    }
                    rule={rule}
                  />
                  <FieldDescription>
                    {rule.type === "dateTime"
                      ? `In your time zone, ${timeZone}. ${RULE_HINTS.dateTime}`
                      : RULE_HINTS[rule.type]}
                  </FieldDescription>
                  <FieldError>
                    {submitted ? ruleErrors[index] : null}
                  </FieldError>
                </Field>
              </li>
            ))}
          </ol>
          {unused.length > 0 ? (
            <Select
              items={Object.fromEntries(
                unused.map((type) => [type, RULE_TYPE_LABELS[type]]),
              )}
              onValueChange={(value) => {
                if (value !== null) {
                  setRules([
                    ...rules,
                    createRule(value as RemoteConfigRuleType),
                  ]);
                }
              }}
              value={null}
            >
              <SelectTrigger
                aria-label="Add a rule"
                className="min-h-11 w-full sm:min-h-9 sm:w-56"
              >
                <Plus aria-hidden="true" className="size-3.5" />
                <SelectValue placeholder="Add a rule" />
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false}>
                <SelectGroup>
                  {unused.map((type) => (
                    <SelectItem key={type} value={type}>
                      {RULE_TYPE_LABELS[type]}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          ) : null}
        </FieldSet>
      </FieldGroup>
      <DialogFooter>
        <Button onClick={onCancel} type="button" variant="outline">
          Cancel
        </Button>
        <Button type="submit">
          {condition === null ? "Add condition" : "Save condition"}
        </Button>
      </DialogFooter>
    </form>
  );
}
