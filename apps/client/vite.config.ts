import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import typegpuPlugin from 'unplugin-typegpu/vite'
import path from 'path'

export default defineConfig({
  plugins: [react(), tailwindcss(), typegpuPlugin({})],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        rewrite: (p) => p.replace(/^\/api/, ''),
      },
    },
  },
})
