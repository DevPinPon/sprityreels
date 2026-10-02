import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    fs: { deny: [".env", ".env.*", "**/.git/**", "**/.sprityreels/**"] },
    watch: { ignored: ["**/.sprityreels/**"] },
  },
  build: { target: "es2022" },
});
