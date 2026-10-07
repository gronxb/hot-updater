import { AlertTriangle, Smartphone } from "lucide-react";
import { useEffect, useId, useState } from "react";

import { PlatformIcon } from "@/components/PlatformIcon";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useRemoteConfigPreviewQuery } from "@/lib/remote-config-api";
import type { RemoteConfigTemplate } from "@/lib/remote-config-draft";

interface PreviewDevice {
  readonly platform: "ios" | "android";
  readonly channel: string;
  readonly appVersion: string;
  readonly cohort: string;
  readonly fingerprintHash: string;
}

const INITIAL_DEVICE: PreviewDevice = {
  platform: "ios",
  channel: "production",
  appVersion: "1.0.0",
  cohort: "1",
  fingerprintHash: "",
};

/** The device after typing pauses, so each keystroke does not ask the server. */
const useSettled = <T,>(value: T, delayMs = 300): T => {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
};

/** What a device with the context entered gets from the draft. */
export function PreviewCard({
  template,
  isDraft,
}: {
  readonly template: RemoteConfigTemplate;
  /** The template has unpublished edits. */
  readonly isDraft: boolean;
}) {
  const id = useId();
  const [device, setDevice] = useState(INITIAL_DEVICE);
  const settled = useSettled(device);
  const preview = useRemoteConfigPreviewQuery({
    template,
    context: { ...settled },
  });
  const keys = Object.keys(template.parameters);
  const set = (field: keyof PreviewDevice, value: string) =>
    setDevice({ ...device, [field]: value });

  return (
    <Card className="overflow-hidden shadow-sm">
      <CardHeader className="border-b px-4 py-3 sm:px-6">
        <CardTitle className="text-sm">
          <h2>Preview a device</h2>
        </CardTitle>
        <CardDescription className="text-xs">
          {isDraft
            ? "The values this device would get once your changes are published."
            : "The values this device gets from the active version."}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 p-4 sm:p-6">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Field>
            <FieldLabel htmlFor={`${id}-platform`}>Platform</FieldLabel>
            <Select
              items={{ ios: "iOS", android: "Android" }}
              onValueChange={(value) => {
                if (value === "ios" || value === "android") {
                  set("platform", value);
                }
              }}
              value={device.platform}
            >
              <SelectTrigger
                className="min-h-11 w-full sm:min-h-9"
                id={`${id}-platform`}
              >
                <SelectValue>
                  <PlatformIcon
                    className="size-3.5"
                    platform={device.platform}
                  />
                  {device.platform === "ios" ? "iOS" : "Android"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="ios">
                    <PlatformIcon className="size-3.5" platform="ios" />
                    iOS
                  </SelectItem>
                  <SelectItem value="android">
                    <PlatformIcon className="size-3.5" platform="android" />
                    Android
                  </SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          {(
            [
              ["channel", "Channel", "production"],
              ["appVersion", "App version", "1.0.0"],
              ["cohort", "Cohort", "1-1000 or a name"],
              ["fingerprintHash", "Fingerprint", "Optional"],
            ] as const
          ).map(([field, label, placeholder]) => (
            <Field key={field}>
              <FieldLabel htmlFor={`${id}-${field}`}>{label}</FieldLabel>
              <Input
                autoComplete="off"
                className="min-h-11 text-base sm:min-h-9 sm:text-xs"
                id={`${id}-${field}`}
                onChange={(event) => set(field, event.target.value)}
                placeholder={placeholder}
                spellCheck={false}
                value={device[field]}
              />
            </Field>
          ))}
        </div>
        {keys.length === 0 ? (
          <Empty className="border py-8">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Smartphone />
              </EmptyMedia>
              <EmptyTitle>Nothing to preview</EmptyTitle>
              <EmptyDescription>
                Add a parameter, and its value for this device shows here.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : preview.data?.status === "invalid" ? (
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertTitle>The draft has problems to fix first</AlertTitle>
            <AlertDescription>
              <ul className="list-disc pl-4">
                {preview.data.issues.slice(0, 5).map((issue) => (
                  <li key={`${issue.path}:${issue.message}`}>
                    {issue.path === "" ? "" : `${issue.path}: `}
                    {issue.message}
                  </li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        ) : preview.isError ? (
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertTitle>The preview couldn't be loaded</AlertTitle>
            <AlertDescription>
              Check the connection, then change a field to try again.
            </AlertDescription>
          </Alert>
        ) : preview.data === undefined ? (
          <div className="flex flex-col gap-2">
            <span className="sr-only">Loading the preview</span>
            {keys.slice(0, 4).map((key) => (
              <Skeleton className="h-8 w-full" key={key} />
            ))}
          </div>
        ) : (
          <dl
            aria-busy={preview.isFetching || undefined}
            className="divide-y rounded-lg border"
          >
            {keys.map((key) => {
              const result =
                preview.data.status === "ok"
                  ? preview.data.parameters[key]
                  : undefined;
              return (
                <div
                  className="grid gap-1 px-3 py-2.5 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto] sm:items-center sm:gap-3"
                  key={key}
                >
                  <dt className="truncate font-mono text-xs font-medium">
                    {key}
                  </dt>
                  <dd className="min-w-0 truncate font-mono text-xs">
                    {result === undefined ? (
                      "…"
                    ) : result.value === null ? (
                      <span className="font-sans text-muted-foreground">
                        In-app default
                      </span>
                    ) : (
                      <span title={result.value}>
                        {result.value.length === 0 ? '""' : result.value}
                      </span>
                    )}
                  </dd>
                  <dd>
                    {result?.condition ===
                    undefined ? null : result.condition === null ? (
                      <Badge variant="outline">Default value</Badge>
                    ) : (
                      <Badge variant="secondary">{result.condition}</Badge>
                    )}
                  </dd>
                </div>
              );
            })}
          </dl>
        )}
      </CardContent>
    </Card>
  );
}
