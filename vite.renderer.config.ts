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
  build: {
    rollupOptions: {
      output: {
        // 重型依赖独立分包，降低首包体积
        manualChunks(id: string) {
          if (id.includes("node_modules")) {
            if (id.includes("react-dom") || id.includes("/react/") || id.endsWith("/react")) {
              return "chunk-react";
            }
          }
          return undefined;
        },
      },
    },
  },

  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
  },
}));
