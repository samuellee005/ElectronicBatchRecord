import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    include: ['pdfjs-dist'],
  },
  server: {
    port: 5173,
    proxy: {
      '/includes': { target: 'http://localhost:8080' },
      '/uploads': { target: 'http://localhost:8080' },
    },
  },
})
