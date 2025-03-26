import type { SnakeCaseBundle } from "@hot-updater/core";

export type Database = {
  public: {
    Tables: {
      bundles: {
        Row: SnakeCaseBundle;
        Insert: SnakeCaseBundle;
        Update: SnakeCaseBundle;
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: any;
  };
};
