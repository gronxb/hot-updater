import { Braces } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  type RemoteConfigParameterValue,
  type RemoteConfigValueType,
  valueTextError,
} from "@/lib/remote-config-draft";

/** A value's starting text for a type: what a new value of that type holds. */
export const initialValueText = (valueType: RemoteConfigValueType): string =>
  valueType === "BOOLEAN"
    ? "false"
    : valueType === "NUMBER"
      ? "0"
      : valueType === "JSON"
        ? "{}"
        : "";

/** The problem with a value, or null; an in-app default has none. */
export const parameterValueError = (
  valueType: RemoteConfigValueType,
  value: RemoteConfigParameterValue,
): string | null =>
  "value" in value ? valueTextError(valueType, value.value) : null;

/**
 * Edits one value of a parameter, by its type, with the option to leave the
 * app's in-app default in place.
 */
export function ValueInput({
  id,
  label,
  valueType,
  value,
  onChange,
  showErrors,
}: {
  readonly id: string;
  /** The visible label; it names the toggle group too when that is text. */
  readonly label: ReactNode;
  readonly valueType: RemoteConfigValueType;
  readonly value: RemoteConfigParameterValue;
  readonly onChange: (value: RemoteConfigParameterValue) => void;
  /** Show a problem once the user tried to save. */
  readonly showErrors: boolean;
}) {
  const inAppDefault = !("value" in value);
  const text = "value" in value ? value.value : "";
  const error = showErrors ? parameterValueError(valueType, value) : null;
  const setText = (next: string) => onChange({ value: next });

  return (
    <Field data-invalid={error !== null || undefined}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <FieldLabel htmlFor={id} id={`${id}-label`}>
          {label}
        </FieldLabel>
        <div className="flex min-h-11 items-center gap-2 text-xs text-muted-foreground sm:min-h-0">
          <Switch
            checked={inAppDefault}
            id={`${id}-in-app-default`}
            onCheckedChange={(checked) =>
              onChange(
                checked
                  ? { useInAppDefault: true }
                  : { value: initialValueText(valueType) },
              )
            }
          />
          <label htmlFor={`${id}-in-app-default`}>Use in-app default</label>
        </div>
      </div>
      {inAppDefault ? (
        <p
          className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground"
          id={id}
        >
          Devices keep the default set in the app's{" "}
          <code className="font-mono">remoteConfig({"{ defaults }"})</code>.
        </p>
      ) : valueType === "BOOLEAN" ? (
        <ToggleGroup
          aria-labelledby={`${id}-label`}
          id={id}
          onValueChange={(values) => {
            const [next] = values as string[];
            if (next === "true" || next === "false") setText(next);
          }}
          value={[text]}
          variant="outline"
        >
          <ToggleGroupItem className="min-h-11 px-4 sm:min-h-8" value="true">
            true
          </ToggleGroupItem>
          <ToggleGroupItem className="min-h-11 px-4 sm:min-h-8" value="false">
            false
          </ToggleGroupItem>
        </ToggleGroup>
      ) : valueType === "NUMBER" ? (
        <Input
          autoComplete="off"
          className="min-h-11 font-mono sm:min-h-9"
          id={id}
          inputMode="decimal"
          onChange={(event) => setText(event.target.value)}
          value={text}
        />
      ) : valueType === "JSON" ? (
        <div className="flex flex-col gap-2">
          <Textarea
            className="min-h-24 font-mono text-xs"
            id={id}
            onChange={(event) => setText(event.target.value)}
            spellCheck={false}
            value={text}
          />
          <Button
            className="self-start"
            disabled={valueTextError("JSON", text) !== null}
            onClick={() => setText(JSON.stringify(JSON.parse(text), null, 2))}
            size="sm"
            type="button"
            variant="outline"
          >
            <Braces data-icon="inline-start" />
            Format JSON
          </Button>
        </div>
      ) : (
        <Textarea
          className="min-h-11 text-sm sm:min-h-9"
          id={id}
          onChange={(event) => setText(event.target.value)}
          rows={2}
          value={text}
        />
      )}
      <FieldError>{error}</FieldError>
    </Field>
  );
}
