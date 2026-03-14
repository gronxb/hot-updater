import type { Bundle } from "@hot-updater/plugin-core";
import { createForm } from "@tanstack/solid-form";
import { useQueryClient } from "@tanstack/solid-query";
import { LoaderCircle } from "lucide-solid";
import semverValid from "semver/ranges/valid";
import { AiFillAndroid, AiFillApple } from "solid-icons/ai";
import { createMemo, createSignal, Show } from "solid-js";
import { Button } from "@/components/ui/button";
import {
  Switch,
  SwitchControl,
  SwitchLabel,
  SwitchThumb,
} from "@/components/ui/switch";
import {
  TextField,
  TextFieldInput,
  TextFieldLabel,
  TextFieldTextArea,
} from "@/components/ui/text-field";
import { showToast } from "@/components/ui/toast";
import { api, useConfigQuery } from "@/lib/api";
import { cn } from "@/lib/utils";

export interface EditBundleSheetFormProps {
  bundle: Bundle;
  onEditSuccess: () => void;
}

type EditBundleFormValues = Omit<Partial<Bundle>, "targetDeviceIds"> & {
  targetDeviceIds?: string;
};

export const EditBundleSheetForm = ({
  bundle,
  onEditSuccess,
}: EditBundleSheetFormProps) => {
  const queryClient = useQueryClient();
  const config = useConfigQuery();

  const [isSubmitting, setIsSubmitting] = createSignal(false);
  const gitUrl = createMemo(() => config.data?.console?.gitUrl ?? null);
  const gitCommitHash = createMemo(() => bundle.gitCommitHash);

  const form = createForm(() => ({
    defaultValues: {
      message: bundle.message,
      targetAppVersion: bundle.targetAppVersion,
      enabled: bundle.enabled,
      shouldForceUpdate: bundle.shouldForceUpdate,
      rolloutPercentage: bundle.rolloutPercentage ?? 100,
      targetDeviceIds: bundle.targetDeviceIds?.join("\n") ?? "",
    } as EditBundleFormValues,
    onSubmit: async ({ value }) => {
      setIsSubmitting(true);
      try {
        const { targetDeviceIds, ...rest } = value;
        const targetDeviceIdsArray =
          targetDeviceIds
            ?.split("\n")
            .map((id) => id.trim())
            .filter((id) => id.length > 0) ?? [];

        const res = await api.bundles[":bundleId"].$patch({
          param: { bundleId: bundle.id },
          json: {
            ...rest,
            rolloutPercentage: rest.rolloutPercentage ?? 100,
            targetDeviceIds:
              targetDeviceIdsArray.length > 0 ? targetDeviceIdsArray : null,
          } satisfies Partial<Bundle>,
        });
        if (res.status !== 200) {
          const json = (await res.json()) as { error: string };
          showToast({
            title: "Error",
            description: json.error,
            variant: "error",
          });
        }
      } catch (e) {
        if (e instanceof Error) {
          showToast({
            title: "Error",
            description: e.message,
            variant: "error",
          });
        }
      } finally {
        setIsSubmitting(false);
        queryClient.invalidateQueries({ queryKey: ["bundle", bundle.id] });
        queryClient.invalidateQueries({ queryKey: ["bundles"] });
        queryClient.invalidateQueries({ queryKey: ["channels"] });
        onEditSuccess();
      }
    },
  }));

  const isValid = form.useStore((state) => state.isValid);
  const rolloutPercentage = form.useStore(
    (state) => state.values.rolloutPercentage ?? 100,
  );

  return (
    <form
      class="flex flex-col gap-3 flex-1"
      onSubmit={(e) => {
        e.preventDefault();
        e.stopPropagation();
        form.handleSubmit();
      }}
    >
      <div>
        <TextField class="grid w-full max-w-sm items-center gap-1.5">
          <TextFieldLabel for="message">Message</TextFieldLabel>
          <form.Field name="message">
            {(field) => (
              <TextFieldInput
                type="text"
                id="message"
                placeholder="Message"
                name={field().name}
                value={field().state.value ?? ""}
                onBlur={field().handleBlur}
                onInput={(e) => field().handleChange(e.currentTarget.value)}
              />
            )}
          </form.Field>
        </TextField>
      </div>

      <Show when={bundle.targetAppVersion}>
        <div>
          <TextField class="grid w-full max-w-sm items-center gap-1.5">
            <TextFieldLabel for="targetAppVersion">
              Target App Version
            </TextFieldLabel>
            <form.Field
              name="targetAppVersion"
              validators={{
                onChange: ({ value }) => {
                  if (value?.length === 0 || !semverValid(value)) {
                    return "Invalid target app version";
                  }

                  return undefined;
                },
              }}
            >
              {(field) => (
                <>
                  <TextFieldInput
                    type="text"
                    id="targetAppVersion"
                    class={cn(
                      field().state.meta.errors.length > 0 &&
                        "border-red-500 focus-visible:ring-red-500",
                    )}
                    placeholder="Target App Version"
                    name={field().name}
                    value={field().state.value ?? ""}
                    onBlur={field().handleBlur}
                    onInput={(e) => field().handleChange(e.currentTarget.value)}
                  />
                  {field().state.meta.errors.length > 0 ? (
                    <em class="text-xs text-red-500">
                      {field().state.meta.errors.join(", ")}
                    </em>
                  ) : (
                    <em class="text-xs text-muted-foreground">
                      {semverValid(field().state.value)}
                    </em>
                  )}
                </>
              )}
            </form.Field>
          </TextField>
        </div>
      </Show>

      <Show when={bundle.fingerprintHash}>
        <div>
          <TextField class="grid w-full max-w-sm items-center gap-1.5">
            <TextFieldLabel for="fingerprintHash">
              Fingerprint Hash
            </TextFieldLabel>
            <TextFieldInput
              type="text"
              id="fingerprintHash"
              value={bundle.fingerprintHash ?? ""}
              disabled
            />
          </TextField>
        </div>
      </Show>

      <div>
        <div class="flex items-center space-x-2">
          <form.Field name="enabled">
            {(field) => (
              <Switch
                class="flex items-center space-x-2"
                checked={field().state.value}
                name={field().name}
                onChange={(value) => field().handleChange(value)}
              >
                <SwitchControl>
                  <SwitchThumb />
                </SwitchControl>
                <SwitchLabel>Enabled</SwitchLabel>
              </Switch>
            )}
          </form.Field>
        </div>
        <p class="text-xs text-muted-foreground mt-[2px]">
          When disabled, this update will not be available to your users.
        </p>
      </div>

      <div>
        <div class="flex items-center space-x-2">
          <form.Field name="shouldForceUpdate">
            {(field) => (
              <Switch
                class="flex items-center space-x-2"
                checked={field().state.value}
                name={field().name}
                onChange={(value) => field().handleChange(value)}
              >
                <SwitchControl>
                  <SwitchThumb />
                </SwitchControl>
                <SwitchLabel>Force Update</SwitchLabel>
              </Switch>
            )}
          </form.Field>
        </div>
        <p class="text-xs text-muted-foreground mt-[2px]">
          When enabled, this update will require users to update before
          continuing to use the application.
        </p>
      </div>

      <div>
        <TextField class="grid w-full max-w-sm items-center gap-1.5">
          <TextFieldLabel for="rolloutPercentage">
            Rollout Percentage: {rolloutPercentage()}%
          </TextFieldLabel>
          <form.Field name="rolloutPercentage">
            {(field) => (
              <>
                <input
                  type="range"
                  id="rolloutPercentage"
                  min="0"
                  max="100"
                  step="5"
                  class="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer"
                  value={field().state.value ?? 100}
                  onInput={(e) =>
                    field().handleChange(Number(e.currentTarget.value))
                  }
                />
                <div class="flex justify-between text-xs text-muted-foreground">
                  <span>0%</span>
                  <span>25%</span>
                  <span>50%</span>
                  <span>75%</span>
                  <span>100%</span>
                </div>
              </>
            )}
          </form.Field>
        </TextField>
        <p class="text-xs text-muted-foreground mt-2">
          Control what percentage of devices receive this update. Set to 100%
          for full rollout, or lower for gradual deployment.
        </p>
      </div>

      <div>
        <TextField class="grid w-full max-w-sm items-center gap-1.5">
          <TextFieldLabel for="targetDeviceIds">
            Target Device IDs (Optional)
          </TextFieldLabel>
          <form.Field name="targetDeviceIds">
            {(field) => (
              <TextFieldTextArea
                id="targetDeviceIds"
                placeholder="Enter device IDs, one per line..."
                class="min-h-[100px]"
                value={field().state.value ?? ""}
                onInput={(e) => field().handleChange(e.currentTarget.value)}
              />
            )}
          </form.Field>
        </TextField>
        <p class="text-xs text-muted-foreground mt-2">
          If specified, only these devices will receive the update. Leave empty
          to use percentage-based rollout instead.
        </p>
      </div>

      <Show
        when={!isSubmitting()}
        fallback={
          <Button type="submit" class="mt-4" disabled>
            <LoaderCircle class="animate-spin" />
          </Button>
        }
      >
        <Button type="submit" class="mt-4" disabled={!isValid()}>
          Save
        </Button>
      </Show>

      <div class="mt-2 space-y-1">
        <h3 class="text-md text-bold font-medium">Metadata</h3>
        <Show when={bundle.platform === "ios"}>
          <div class="text-sm text-muted-foreground flex flex-row items-center">
            Platform:{" "}
            <p class="ml-2 flex flex-row items-center">
              <AiFillApple class="inline-block" /> iOS
            </p>
          </div>
        </Show>
        <Show when={bundle.platform === "android"}>
          <div class="text-sm text-muted-foreground flex flex-row items-center">
            Platform:{" "}
            <p class="ml-2 flex flex-row items-center">
              <AiFillAndroid class="inline-block" /> Android
            </p>
          </div>
        </Show>
        <Show when={bundle.metadata?.app_version}>
          {(appVersion) => (
            <div class="text-sm text-muted-foreground flex flex-row items-center">
              App Version: <p class="ml-2">{appVersion()}</p>
            </div>
          )}
        </Show>
        <Show when={bundle.channel}>
          <div class="text-sm text-muted-foreground flex flex-row items-center">
            Channel: <p class="ml-2">{bundle.channel}</p>
          </div>
        </Show>

        <Show when={gitCommitHash()}>
          {(gitCommitHash) => (
            <div class="text-sm text-muted-foreground flex flex-row items-center">
              Commit Hash:{" "}
              {gitUrl() ? (
                <a
                  href={`${gitUrl()}/commit/${gitCommitHash()}`}
                  target="_blank"
                  rel="noreferrer"
                  class="ml-2"
                >
                  {gitCommitHash().slice(0, 8)}
                </a>
              ) : (
                <p class="ml-2">{gitCommitHash().slice(0, 8)}</p>
              )}
            </div>
          )}
        </Show>
      </div>
    </form>
  );
};
