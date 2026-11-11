import { createFileRoute } from "@tanstack/react-router";

import { IosDevicesPage } from "@/components/features/native-builds/IosDevicesPage";

import { validateIosDevicesSearch } from "./-native-builds-search";

export const Route = createFileRoute("/native-builds_/devices")({
  component: IosDevicesRoute,
  validateSearch: validateIosDevicesSearch,
});

function IosDevicesRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <IosDevicesPage
      onSearchChange={(next) => void navigate({ search: next, replace: true })}
      search={search}
    />
  );
}
