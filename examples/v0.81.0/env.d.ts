declare module "@env" {
  export const HOT_UPDATER_APP_BASE_URL: string | undefined;
}

interface ImportMetaEnv {
  readonly HOT_UPDATER_APP_BASE_URL: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
