import { type NativeBuild, nativeBuildsColumns } from "./native-builds-columns";
import { NativeBuildsDataTable } from "./native-builds-data-table";

interface NativeBuildsProps {
  data: NativeBuild[];
  onRowClick: (buildId: string) => void;
}

export function NativeBuilds(props: NativeBuildsProps) {
  const handleRowClick = (build: NativeBuild) => {
    props.onRowClick(build.id);
  };

  return (
    <div class="space-y-4">
      <div class="flex items-center justify-between">
        <div>
          <h1 class="text-2xl font-bold tracking-tight">Native Builds</h1>
          <p class="text-muted-foreground">
            Manage and download your native application builds
          </p>
        </div>
      </div>

      <NativeBuildsDataTable
        columns={nativeBuildsColumns}
        data={props.data}
        onRowClick={handleRowClick}
      />
    </div>
  );
}