import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import electron from "vite-plugin-electron/simple";

export default defineConfig(async () => ({
  base: "./",
  plugins: [
    react(),
    tailwindcss(),
    electron({
      main: {
        entry: {
          main: "src/main/index.ts",
        },
        vite: {
          build: {
            emptyOutDir: true,
          },
        },
        onstart: async ({ startup }) => {
          const env = { ...process.env };
          delete env.ELECTRON_RUN_AS_NODE;
          await startup(["."], { env });
        },
      },
      preload: {
        input: {
          preload: "src/preload/index.ts",
        },
        vite: {
          build: {
            emptyOutDir: false,
          },
        },
      },
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },

  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
  },
}));
