/// <reference types="vite/client" />

declare module '*.css' {}

/** Built by vite.config.ts from the client manifest; SSR build only. */
declare module 'virtual:underlay/client-assets' {
  export const assetTags: { head: string; body: string }
}
