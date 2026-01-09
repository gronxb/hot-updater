import { defineConfig } from 'vite'
import { devtools } from '@tanstack/devtools-vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import viteTsConfigPaths from 'vite-tsconfig-paths'
import tailwindcss from '@tailwindcss/vite'
import { nitro } from 'nitro/vite'

const config = defineConfig({
  plugins: [
    devtools(),
    nitro(),
    // this is the plugin that enables path aliases
    viteTsConfigPaths({
      projects: ['./tsconfig.json'],
    }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
  assetsInclude: ['**/*.node'],
  optimizeDeps: {
    exclude: ['oxc-transform', '@oxc-transform/binding-darwin-arm64'],
  },
  ssr: {
    noExternal: ['@hot-updater/cli-tools', '@hot-updater/plugin-core', '@hot-updater/core', '@hot-updater/mock'],
    external: ['oxc-transform', '@oxc-transform/binding-darwin-arm64', '@oxc-transform/binding-wasm32-wasi'],
  },
  build: {
    rollupOptions: {
      external: [
        'oxc-transform',
        '@oxc-transform/binding-darwin-arm64',
        '@oxc-transform/binding-wasm32-wasi',
      ],
    },
  },
})

export default config
