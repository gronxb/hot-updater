import { Pencil, Plus, Search, SlidersHorizontal, Trash2 } from "lucide-react";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  describeValue,
  type RemoteConfigCondition,
  type RemoteConfigParameter,
  type RemoteConfigTemplate,
  VALUE_TYPE_LABELS,
} from "@/lib/remote-config-draft";

import { ParameterDialog } from "./ParameterDialog";

/** A value's text in one line, as the list shows it. */
function ValueText({ text }: { readonly text: string }) {
  return (
    <span
      className="block min-w-0 truncate font-mono text-xs text-foreground"
      title={text}
    >
      {text}
    </span>
  );
}

function ParameterRow({
  parameterKey,
  parameter,
  conditions,
  onEdit,
  onRemove,
}: {
  readonly parameterKey: string;
  readonly parameter: RemoteConfigParameter;
  readonly conditions: readonly RemoteConfigCondition[];
  readonly onEdit: () => void;
  readonly onRemove: () => void;
}) {
  // In priority order, as devices resolve them.
  const conditional = conditions.filter(
    ({ name }) => parameter.conditionalValues?.[name] !== undefined,
  );
  return (
    <li className="grid gap-3 px-4 py-3 sm:px-6 md:grid-cols-[minmax(0,15rem)_minmax(0,1fr)_auto] md:items-start">
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-mono text-sm font-medium">
            {parameterKey}
          </span>
          <Badge className="shrink-0" variant="outline">
            {VALUE_TYPE_LABELS[parameter.valueType]}
          </Badge>
        </div>
        {parameter.description === undefined ? null : (
          <p className="mt-1 text-xs text-muted-foreground">
            {parameter.description}
          </p>
        )}
      </div>
      <dl className="grid min-w-0 grid-cols-[minmax(0,7rem)_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">
        {conditional.map(({ name }) => (
          <div className="contents" key={name}>
            <dt className="truncate text-muted-foreground" title={name}>
              {name}
            </dt>
            <dd className="min-w-0">
              <ValueText
                text={describeValue(parameter.conditionalValues![name]!)}
              />
            </dd>
          </div>
        ))}
        <dt className="text-muted-foreground">Default</dt>
        <dd className="min-w-0">
          {"value" in parameter.defaultValue ? (
            <ValueText text={describeValue(parameter.defaultValue)} />
          ) : (
            <span className="text-muted-foreground">In-app default</span>
          )}
        </dd>
      </dl>
      <div className="flex gap-1 md:justify-end">
        <Button
          className="min-h-11 md:min-h-7"
          onClick={onEdit}
          size="sm"
          variant="outline"
        >
          <Pencil data-icon="inline-start" />
          Edit
        </Button>
        <Button
          aria-label={`Delete ${parameterKey}`}
          className="size-11 md:size-7"
          onClick={onRemove}
          size="icon"
          variant="ghost"
        >
          <Trash2 />
        </Button>
      </div>
    </li>
  );
}

/** The draft's parameters, with what each device gets for them. */
export function ParametersCard({
  template,
  onSaveParameter,
  onRemoveParameter,
  onAddCondition,
}: {
  readonly template: RemoteConfigTemplate;
  readonly onSaveParameter: (
    previousKey: string | null,
    key: string,
    parameter: RemoteConfigParameter,
  ) => void;
  readonly onRemoveParameter: (key: string) => void;
  readonly onAddCondition: (condition: RemoteConfigCondition) => void;
}) {
  const [editing, setEditing] = useState<{ readonly key: string | null } | null>(
    null,
  );
  const [filter, setFilter] = useState("");
  const keys = Object.keys(template.parameters);
  const shown = keys.filter((key) =>
    key.toLowerCase().includes(filter.trim().toLowerCase()),
  );
  const editingKey = editing?.key ?? null;

  return (
    <Card className="overflow-hidden shadow-sm">
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-3 space-y-0 border-b px-4 py-3 sm:px-6">
        <CardTitle className="text-sm">
          <h2>Parameters</h2>
        </CardTitle>
        <div className="flex w-full flex-wrap gap-2 sm:w-auto">
          {keys.length > 5 ? (
            <InputGroup className="min-h-11 w-full sm:min-h-8 sm:w-56">
              <InputGroupAddon>
                <Search aria-hidden="true" />
              </InputGroupAddon>
              <InputGroupInput
                aria-label="Filter parameters by key"
                className="text-base sm:text-xs"
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Filter by key"
                value={filter}
              />
            </InputGroup>
          ) : null}
          <Button
            className="min-h-11 sm:min-h-7"
            onClick={() => setEditing({ key: null })}
          >
            <Plus data-icon="inline-start" />
            Add parameter
          </Button>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {keys.length === 0 ? (
          <Empty className="py-10">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <SlidersHorizontal />
              </EmptyMedia>
              <EmptyTitle>No parameters</EmptyTitle>
              <EmptyDescription>
                Add a parameter, give it a default, then publish to change the
                app without a new build.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button
                className="min-h-11 sm:min-h-7"
                onClick={() => setEditing({ key: null })}
              >
                <Plus data-icon="inline-start" />
                Add parameter
              </Button>
            </EmptyContent>
          </Empty>
        ) : shown.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-10 text-center text-xs text-muted-foreground">
            <p className="font-medium text-foreground">No matching keys</p>
            <Button onClick={() => setFilter("")} size="sm" variant="outline">
              Clear filter
            </Button>
          </div>
        ) : (
          <ul aria-label="Parameters" className="divide-y">
            {shown.map((key) => (
              <ParameterRow
                conditions={template.conditions}
                key={key}
                onEdit={() => setEditing({ key })}
                onRemove={() => onRemoveParameter(key)}
                parameter={template.parameters[key]!}
                parameterKey={key}
              />
            ))}
          </ul>
        )}
      </CardContent>
      <ParameterDialog
        conditions={template.conditions}
        onAddCondition={onAddCondition}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        onSave={(key, parameter) =>
          onSaveParameter(editingKey, key, parameter)
        }
        open={editing !== null}
        parameter={
          editingKey === null ? null : (template.parameters[editingKey] ?? null)
        }
        parameterKey={editingKey}
        takenKeys={keys.filter((key) => key !== editingKey)}
      />
    </Card>
  );
}
