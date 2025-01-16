  # Hot Updater

  A self-hostable OTA (Over-The-Air) update solution for React Native.

  ![hot-updater](https://raw.githubusercontent.com/gronxb/hot-updater/main/demo.gif)


  ## Documentation

  Full documentation is available at:
  https://hot-updater.gronxb.io

  ## Key Features

  - **Self-Hosted**: Complete control over your update infrastructure
  - **Multi-Platform**: Support for both iOS and Android
  - **Web Console**: Intuitive update management interface
  - **Plugin System**: Support for various storage providers (AWS S3, GitHub, etc.)
  - **Version Control**: Robust app version management through semantic versioning
  - **New Architecture**: Support for new architecture like React Native


  ## Plugin System

  Hot Updater provides high extensibility through its plugin system. Each functionality like build, storage, and database is separated into plugins, allowing users to configure them according to their needs.

  ### Plugin Types

  - **Build Plugin**: Support for bundlers like Metro, Re.pack
  - **Storage Plugin**: Support for bundle storage like AWS S3, Supabase Storage
  - **Database Plugin**: Support for metadata storage like Supabase Database, PostgreSQL

  ### Configuration Example

  * **supabase**
  ```tsx
  import { metro } from "@hot-updater/metro";
  import { supabaseDatabase, supabaseStorage } from "@hot-updater/supabase";
  import { defineConfig } from "hot-updater";
  import "dotenv/config";

  export default defineConfig({
    build: metro(),
    storage: supabaseStorage({
      supabaseUrl: process.env.HOT_UPDATER_SUPABASE_URL!,
      supabaseAnonKey: process.env.HOT_UPDATER_SUPABASE_ANON_KEY!,
      bucketName: process.env.HOT_UPDATER_SUPABASE_BUCKET_NAME!,
    }),
    database: supabaseDatabase({
      supabaseUrl: process.env.HOT_UPDATER_SUPABASE_URL!,
      supabaseAnonKey: process.env.HOT_UPDATER_SUPABASE_ANON_KEY!,
    }),
  });
  ```