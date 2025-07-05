import type { SnakeCaseBundle, SnakeCaseNativeBuild } from "@hot-updater/core";

export type Database = {
  public: {
    Tables: {
      bundles: {
        Row: SnakeCaseBundle;
        Insert: SnakeCaseBundle;
        Update: SnakeCaseBundle;
        Relationships: [];
      };
      native_builds: {
        Row: SnakeCaseNativeBuild;
        Insert: SnakeCaseNativeBuild;
        Update: Partial<SnakeCaseNativeBuild>;
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: any;
  };
};
