export interface InfrastructureUpdate {
  readonly version: string;
  readonly note: string;
}

// Every requirement must have infrastructure-upgrades/<version>.md. The build
// validates and packages those files; retain earlier releases for skipped upgrades.
export const INFRASTRUCTURE_UPDATES = [
  {
    version: "1.0.0",
    note: "Release Catalog, manifest artifact protocol v1, and storage engine infrastructure generation",
  },
  {
    version: "1.2.0",
    note: "Core schema 1.2.0: the native build registry table and the tables of the official plugins added beside it",
  },
] as const satisfies readonly [InfrastructureUpdate, ...InfrastructureUpdate[]];
