import type { RouteDefinition } from "@solidjs/router";

export const route: RouteDefinition = {
  load: () => {},
};

export const EmptyConfigPage = () => {
  return (
    <div className="flex flex-col items-center justify-center h-full">
      <div className="text-lg font-bold">No configuration found</div>
      <div className="text-sm text-gray-500">
        Please create a new configuration or import an existing one.
      </div>
    </div>
  );
};
