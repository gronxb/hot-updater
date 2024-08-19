import type { Env } from "hono";
import type { Session, User } from "lucia";

export interface Context extends Env {
  Variables: {
    user: User | null;
    session: Session | null;
  };
}

/**
 * Declare our loaders and actions context type
 */
declare module "@remix-run/node" {
  interface AppLoadContext {
    /**
     * The app version from the build assets
     */
    readonly user: User | null;
    readonly session: Session | null;
  }
}
