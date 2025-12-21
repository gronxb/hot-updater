import type { Platform, SnakeCaseBundle } from "@hot-updater/core";

type DeviceEventRow = {
  id: string;
  device_id: string;
  bundle_id: string;
  event_type: "PROMOTED" | "RECOVERED";
  platform: Platform;
  app_version: string | null;
  channel: string;
  metadata: Record<string, unknown>;
};

export type Database = {
  public: {
    Tables: {
      bundles: {
        Row: SnakeCaseBundle;
        Insert: SnakeCaseBundle;
        Update: SnakeCaseBundle;
        Relationships: [];
      };
      device_events: {
        Row: DeviceEventRow;
        Insert: DeviceEventRow;
        Update: Partial<DeviceEventRow>;
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: any;
  };
};
