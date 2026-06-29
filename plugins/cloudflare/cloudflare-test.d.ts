declare module "cloudflare:test" {
  export const env: Env;
}

declare module "*.sql?raw" {
  const content: string;
  export default content;
}
