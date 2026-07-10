import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev only: Vite serves the SPA on its own port and proxies API/auth/socket
// traffic to the Express server. In production the same Express server just
// serves web/dist directly - it's one app, not two (see server/index.js).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/auth': 'http://localhost:3000',
      '/socket.io': { target: 'http://localhost:3000', ws: true },
    },
  },
});
