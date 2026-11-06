import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Builds straight into the website: pawansinha.com.au/projects/video-editor/
export default defineConfig({
  plugins: [react()],
  base: '/projects/video-editor/',
  build: {
    outDir: '../docs/projects/video-editor',
    emptyOutDir: true
  }
})
