export interface InfrastructureUpdate {
  readonly version: string;
  readonly note: string;
}

// Every requirement must have infrastructure-upgrades/<version>.md. The build
// validates and packages those files; retain earlier releases for skipped upgrades.
export const INFRASTRUCTURE_UPDATES = [
  {
    version: "1.0.0",
    note: "Release Catalog infrastructure generation",
  },
] as const satisfies readonly [InfrastructureUpdate, ...InfrastructureUpdate[]];
