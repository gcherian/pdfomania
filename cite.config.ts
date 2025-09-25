import { defineConfig } from "vite";

export default defineConfig({
  server: { port: 5173 },
  optimizeDeps: {
    include: ["pdfjs-dist/build/pdf.worker.min.mjs"]
  }
});
