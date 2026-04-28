import { defineConfig } from "astro/config";
import node from "@astrojs/node";
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  output: "server",
  site: "https://underlay.org",
  adapter: node({ mode: "standalone" }),
  integrations: [react()],
  security: {
    checkOrigin: false,
  },
  server: { port: 4321, host: "0.0.0.0" },
  vite: {
    plugins: [tailwindcss()],
    server: {
      proxy: {
        "/api": "http://localhost:3000",
      },
    },
  },
});
