import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      output: {
        // Core libraries change rarely: keep them in their own long-cached file.
        manualChunks: { vendor: ['react', 'react-dom', 'react-router', '@tanstack/react-query', 'socket.io-client'] },
      },
    },
  },
  server: {
    port: 5173,
    // Same-origin API in development so the httpOnly refresh cookie just works.
    proxy: {
      '/api': { target: 'http://localhost:4000', changeOrigin: false },
      '/socket.io': { target: 'http://localhost:4000', ws: true },
    },
  },
});
