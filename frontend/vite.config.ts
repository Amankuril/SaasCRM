import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Same-origin API so the httpOnly refresh cookie just works.
const proxy = {
  '/api': { target: 'http://localhost:4000', changeOrigin: false },
  '/socket.io': { target: 'http://localhost:4000', ws: true },
};
// HTTPS tunnels for local testing (Facebook login/Embedded Signup refuses http://localhost).
const allowedHosts = ['.ngrok-free.dev', '.ngrok-free.app', '.ngrok.app', '.ngrok.dev'];

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
  server: { port: 5173, allowedHosts, proxy },
  // `npm run tunnel` (built app on :4173): use this behind ngrok. The dev server's
  // hundreds of separate module requests stall on free tunnels.
  preview: { port: 4173, allowedHosts, proxy },
});
