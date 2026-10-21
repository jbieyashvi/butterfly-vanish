import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  // GitHub Pages serves the site from /<repo>/; set by the deploy workflow
  base: process.env.BASE_PATH ?? '/',
  plugins: [react()],
})
