import { Plus, Trash2 } from "lucide-react";
import { type FormEvent, useId, useState } from "react";

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
import {
  describeRule,
  parameterKeyError,
  type RemoteConfigCondition,
  type RemoteConfigParameter,
  type RemoteConfigParameterValue,
  type RemoteConfigValueType,
  VALUE_TYPE_LABELS,
} from "@/lib/remote-config-draft";

import { ConditionDialog } from "./ConditionDialog";
import {
  initialValueText,
  parameterValueError,
  ValueInput,
} from "./ValueInput";

const VALUE_TYPES = Object.keys(VALUE_TYPE_LABELS) as RemoteConfigValueType[];

/** How the app reads a value of each type; JSON arrives as text to parse. */
const READ_METHODS: Readonly<Record<RemoteConfigValueType, string>> = {
  STRING: "getString",
  NUMBER: "getNumber",
  BOOLEAN: "getBoolean",
  JSON: "getString",
};

/** A value converted to another type: kept when it still fits, reset when not. */
const retype = (
  value: RemoteConfigParameterValue,
  valueType: RemoteConfigValueType,
): RemoteConfigParameterValue =>
  "value" in value && parameterValueError(valueType, value) !== null
    ? { value: initialValueText(valueType) }
    : value;

/**
 * Adds or edits a parameter: its key, type, default value, and a value for
 * any of the template's conditions, which it can also add on the spot.
 */
export function ParameterDialog({
  open,
  onOpenChange,
  parameterKey,
  parameter,
  takenKeys,
  conditions,
  onSave,
  onAddCondition,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The key of the parameter to edit, or null for a new one. */
  readonly parameterKey: string | null;
  readonly parameter: RemoteConfigParameter | null;
  readonly takenKeys: readonly string[];
  readonly conditions: readonly RemoteConfigCondition[];
  readonly onSave: (key: string, parameter: RemoteConfigParameter) => void;
  readonly onAddCondition: (condition: RemoteConfigCondition) => void;
}) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto data-nested-dialog-open:after:absolute data-nested-dialog-open:after:inset-0 data-nested-dialog-open:after:rounded-xl data-nested-dialog-open:after:bg-background/70 sm:max-w-2xl">
        {open ? (
          <ParameterForm
            conditions={conditions}
            onAddCondition={onAddCondition}
            onCancel={() => onOpenChange(false)}
            onSave={(key, next) => {
              onSave(key, next);
              onOpenChange(false);
            }}
            parameter={parameter}
            parameterKey={parameterKey}
            takenKeys={takenKeys}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ParameterForm({
  parameterKey,
  parameter,
  takenKeys,
  conditions,
  onSave,
  onCancel,
  onAddCondition,
}: {
  readonly parameterKey: string | null;
  readonly parameter: RemoteConfigParameter | null;
  readonly takenKeys: readonly string[];
  readonly conditions: readonly RemoteConfigCondition[];
  readonly onSave: (key: string, parameter: RemoteConfigParameter) => void;
  readonly onCancel: () => void;
  readonly onAddCondition: (condition: RemoteConfigCondition) => void;
}) {
  const id = useId();
  const [key, setKey] = useState(parameterKey ?? "");
  const [valueType, setValueType] = useState<RemoteConfigValueType>(
    parameter?.valueType ?? "STRING",
  );
  const [description, setDescription] = useState(parameter?.description ?? "");
  const [defaultValue, setDefaultValue] = useState<RemoteConfigParameterValue>(
    parameter?.defaultValue ?? { value: "" },
  );
  const [conditionalValues, setConditionalValues] = useState<
    Readonly<Record<string, RemoteConfigParameterValue>>
  >(parameter?.conditionalValues ?? {});
  const [submitted, setSubmitted] = useState(false);
  const [addingCondition, setAddingCondition] = useState(false);

  const keyError = parameterKeyError(key.trim(), takenKeys);
  const valued = conditions.filter(
    ({ name }) => conditionalValues[name] !== undefined,
  );
  const unvalued = conditions.filter(
    ({ name }) => conditionalValues[name] === undefined,
  );
  const invalid =
    keyError !== null ||
    description.length > 256 ||
    [defaultValue, ...Object.values(conditionalValues)].some(
      (value) => parameterValueError(valueType, value) !== null,
    );

  const changeType = (next: RemoteConfigValueType) => {
    setValueType(next);
    setDefaultValue(retype(defaultValue, next));
    setConditionalValues(
      Object.fromEntries(
        Object.entries(conditionalValues).map(([name, value]) => [
          name,
          retype(value, next),
        ]),
      ),
    );
  };

  const addValueFor = (name: string) =>
    setConditionalValues({
      ...conditionalValues,
      [name]: { value: initialValueText(valueType) },
    });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitted(true);
    if (invalid) return;
    const kept = Object.fromEntries(
      conditions
        .filter(({ name }) => conditionalValues[name] !== undefined)
        .map(({ name }) => [name, conditionalValues[name]!]),
    );
    onSave(key.trim(), {
      valueType,
      defaultValue,
      ...(Object.keys(kept).length === 0 ? {} : { conditionalValues: kept }),
      ...(description.trim().length === 0
        ? {}
        : { description: description.trim() }),
    });
  };

  return (
    <>
      <form className="flex flex-col gap-4" noValidate onSubmit={submit}>
        <DialogHeader>
          <DialogTitle>
            {parameterKey === null ? "Add parameter" : "Edit parameter"}
          </DialogTitle>
          <DialogDescription>
            The app reads it with{" "}
            <code className="font-mono">
              config.{READ_METHODS[valueType]}("{key.trim() || "key"}")
            </code>
            .
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_11rem]">
            <Field data-invalid={(submitted && keyError !== null) || undefined}>
              <FieldLabel htmlFor={`${id}-key`}>Key</FieldLabel>
              <Input
                autoComplete="off"
                className="min-h-11 font-mono sm:min-h-9"
                id={`${id}-key`}
                maxLength={257}
                onChange={(event) => setKey(event.target.value)}
                placeholder="welcome_message"
                spellCheck={false}
                value={key}
              />
              <FieldError>{submitted ? keyError : null}</FieldError>
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-type`}>Type</FieldLabel>
              <Select
                items={VALUE_TYPE_LABELS}
                onValueChange={(value) => {
                  if (value !== null)
                    changeType(value as RemoteConfigValueType);
                }}
                value={valueType}
              >
                <SelectTrigger
                  className="min-h-11 w-full sm:min-h-9"
                  id={`${id}-type`}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {VALUE_TYPES.map((type) => (
                      <SelectItem key={type} value={type}>
                        {VALUE_TYPE_LABELS[type]}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
          </div>
          <Field data-invalid={description.length > 256 || undefined}>
            <FieldLabel htmlFor={`${id}-description`}>Description</FieldLabel>
            <Input
              autoComplete="off"
              className="min-h-11 sm:min-h-9"
              id={`${id}-description`}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Optional: what the app does with it"
              value={description}
            />
            <FieldError>
              {description.length > 256 ? "Use 256 characters or fewer." : null}
            </FieldError>
          </Field>
          <ValueInput
            id={`${id}-default`}
            label="Default value"
            onChange={setDefaultValue}
            showErrors={submitted}
            value={defaultValue}
            valueType={valueType}
          />
          <FieldSet>
            <FieldLegend variant="label">Conditional values</FieldLegend>
            <FieldDescription>
              Devices that match a condition get its value. When several match,
              the first in the Conditions list wins.
            </FieldDescription>
            {valued.length > 0 ? (
              <ul className="flex flex-col gap-3">
                {valued.map((condition) => (
                  <li className="rounded-lg border p-3" key={condition.name}>
                    <div className="mb-2 flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">
                          {condition.name}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {condition.rules.map(describeRule).join(" · ")}
                        </p>
                      </div>
                      <Button
                        aria-label={`Remove the value for ${condition.name}`}
                        className="size-11 sm:size-7"
                        onClick={() => {
                          const { [condition.name]: _removed, ...rest } =
                            conditionalValues;
                          setConditionalValues(rest);
                        }}
                        size="icon-sm"
                        type="button"
                        variant="ghost"
                      >
                        <Trash2 />
                      </Button>
                    </div>
                    <ValueInput
                      id={`${id}-${condition.name}`}
                      label={
                        <>
                          Value
                          <span className="sr-only"> for {condition.name}</span>
                        </>
                      }
                      onChange={(value) =>
                        setConditionalValues({
                          ...conditionalValues,
                          [condition.name]: value,
                        })
                      }
                      showErrors={submitted}
                      value={conditionalValues[condition.name]!}
                      valueType={valueType}
                    />
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="flex flex-wrap gap-2">
              {unvalued.length > 0 ? (
                <Select
                  items={Object.fromEntries(
                    unvalued.map(({ name }) => [name, name]),
                  )}
                  onValueChange={(value) => {
                    if (value !== null) addValueFor(value);
                  }}
                  value={null}
                >
                  <SelectTrigger
                    aria-label="Add a value for a condition"
                    className="min-h-11 w-full sm:min-h-9 sm:w-64"
                  >
                    <Plus aria-hidden="true" className="size-3.5" />
                    <SelectValue placeholder="Add a value for a condition" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {unvalued.map(({ name }) => (
                        <SelectItem key={name} value={name}>
                          {name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              ) : null}
              <Button
                className="min-h-11 sm:min-h-7"
                onClick={() => setAddingCondition(true)}
                type="button"
                variant="outline"
              >
                <Plus data-icon="inline-start" />
                New condition
              </Button>
            </div>
          </FieldSet>
        </FieldGroup>
        <DialogFooter>
          <Button onClick={onCancel} type="button" variant="outline">
            Cancel
          </Button>
          <Button type="submit">
            {parameterKey === null ? "Add parameter" : "Save parameter"}
          </Button>
        </DialogFooter>
      </form>
      <ConditionDialog
        condition={null}
        onOpenChange={setAddingCondition}
        onSave={(condition) => {
          onAddCondition(condition);
          addValueFor(condition.name);
        }}
        open={addingCondition}
        takenNames={conditions.map(({ name }) => name)}
      />
    </>
  );
}
