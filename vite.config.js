import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg}']
      },
      manifest: {
        name: 'GeoLock App',
        short_name: 'GeoLock',
        description: 'Offline geographic mapping and logging app',
        theme_color: '#0f172a',
        background_color: '#0f172a',
        display: 'standalone',
        icons: [] // 👈 Prazan niz uklanja 404 grešku za nedostajuće fajlove
      }
    })
  ]
});