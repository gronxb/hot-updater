/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_HOT_UPDATER_SDK_VERSION?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
