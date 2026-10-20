import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [sveltekit()],
  build: {
    // Inline data: URLs for small assets would need a looser CSP; keep everything in files.
    assetsInlineLimit: 0,
  },
});
