import { PostgresJsAdapter } from "@lucia-auth/adapter-postgresql";

import { GitHub } from "arctic";
import dotenv from "dotenv";
import { Lucia } from "lucia";
import { db } from "./db.js";

import type { DatabaseUser } from "./db.js";

dotenv.config();

const adapter = new PostgresJsAdapter(db, {
  user: "user",
  session: "session",
});

export const lucia = new Lucia(adapter, {
  sessionCookie: {
    attributes: {
      secure: process.env.NODE_ENV === "production",
    },
  },
  getUserAttributes: (attributes) => {
    return {
      githubId: attributes.github_id,
      username: attributes.username,
      avatarUrl: attributes.avatar_url,
      email: attributes.email,
    };
  },
});

export const github = new GitHub(
  process.env.GITHUB_CLIENT_ID!,
  process.env.GITHUB_CLIENT_SECRET!,
);

declare module "lucia" {
  interface Register {
    Lucia: typeof lucia;
    DatabaseUserAttributes: Omit<DatabaseUser, "id">;
  }
}
