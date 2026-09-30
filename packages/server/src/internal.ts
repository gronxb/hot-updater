/**
 * What Hot Updater's own tooling reads from a server definition, such as
 * the managed providers' init. Not a public API: it changes with the CLI.
 */
export {
  clientEndpointsOf,
  managedServerDefinitionOf,
  type ManagedServer,
} from "./assembly/managedServer";
