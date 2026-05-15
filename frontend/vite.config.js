import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    include: ['pdfjs-dist'],
  },
  server: {
    // Listen on all interfaces so WSL / LAN browsers can reach the dev server
    host: true,
    port: 5173,
    strictPort: true,
    proxy: {
      // Dev PHP (`php -S … router.php`). Port 9080 avoids conflicts when 8080 is already in use locally.
      '/includes': {
        target: 'http://127.0.0.1:9080',
        changeOrigin: true,
      },
      '/uploads': {
        target: 'http://127.0.0.1:9080',
        changeOrigin: true,
      },
    },
  },
})
