import type { RouteDefinition } from "@solidjs/router";

export const route: RouteDefinition = {
  load: () => {},
};

export const EmptyConfig = () => {
  return (
    <div class="flex flex-col items-center justify-center h-full">
      <div class="text-lg font-bold">No configuration found</div>
      <div class="text-sm text-gray-500">
        Please create a new configuration or import an existing one.
      </div>
    </div>
  );
};
