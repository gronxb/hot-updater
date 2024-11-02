import { Button } from "@/components/ui/button";
import {
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
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
} from "@/components/ui/text-field";
import { api } from "@/lib/api";
import type { UpdateSource } from "@hot-updater/plugin-core";
import { createAsync } from "@solidjs/router";
import { createForm } from "@tanstack/solid-form";

interface EditUpdateSourceSheetFormProps {
  source: UpdateSource;
  onEditSuccess: () => void;
}

const EditUpdateSourceSheetForm = ({
  source,
  onEditSuccess,
}: EditUpdateSourceSheetFormProps) => {
  const form = createForm(() => ({
    defaultValues: {
      description: source.description,
      targetVersion: source.targetVersion,
      enabled: source.enabled,
      forceUpdate: source.forceUpdate,
    },
    onSubmit: async ({ value }) => {
      // Do something with form data
      await api.rpc.updateUpdateSource.$post({
        json: {
          targetBundleVersion: source.bundleVersion,
          updateSource: value,
        },
      });
      onEditSuccess();
    },
  }));

  return (
    <form
      class="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        e.stopPropagation();
        form.handleSubmit();
      }}
    >
      <div>
        <TextField class="grid w-full max-w-sm items-center gap-1.5">
          <TextFieldLabel for="description">Description</TextFieldLabel>
          <form.Field name="description">
            {(field) => (
              <TextFieldInput
                type="text"
                id="description"
                placeholder="Description"
                name={field().name}
                value={field().state.value}
                onBlur={field().handleBlur}
                onInput={(e) => field().handleChange(e.currentTarget.value)}
              />
            )}
          </form.Field>
        </TextField>
      </div>

      <div>
        <TextField class="grid w-full max-w-sm items-center gap-1.5">
          <TextFieldLabel for="targetVersion">Target Version</TextFieldLabel>
          <form.Field name="targetVersion">
            {(field) => (
              <TextFieldInput
                type="text"
                id="targetVersion"
                placeholder="Target Version"
                name={field().name}
                value={field().state.value}
                onBlur={field().handleBlur}
                onInput={(e) => field().handleChange(e.currentTarget.value)}
              />
            )}
          </form.Field>
        </TextField>
      </div>

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
          <form.Field name="forceUpdate">
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
      <Button type="submit" class="mt-4">
        Save
      </Button>
    </form>
  );
};

export interface EditUpdateSourceSheetContentProps {
  bundleVersion: number;
  onClose: () => void;
}

export const EditUpdateSourceSheetContent = ({
  bundleVersion,
  onClose,
}: EditUpdateSourceSheetContentProps) => {
  const source = createAsync(() =>
    api.rpc.getUpdateSourceByBundleVersion
      .$post({ json: { bundleVersion } })
      .then((res) => res.json()),
  );

  return (
    <SheetContent class="flex flex-col h-full">
      <SheetHeader class="mb-4">
        <SheetTitle>Edit {source()?.bundleVersion}</SheetTitle>
      </SheetHeader>

      {source() ? (
        <EditUpdateSourceSheetForm source={source()!} onEditSuccess={onClose} />
      ) : (
        <SheetDescription>
          No update source found for bundle version {bundleVersion}
        </SheetDescription>
      )}
    </SheetContent>
  );
};
