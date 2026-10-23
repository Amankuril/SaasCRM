import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // Same-origin API in development so the httpOnly refresh cookie just works.
    proxy: {
      '/api': { target: 'http://localhost:4000', changeOrigin: false },
    },
  },
});
