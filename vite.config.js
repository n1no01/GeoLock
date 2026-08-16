import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      includeAssets: ['favicon.ico', 'apple-touch-icon.png', 'icon192.png', 'icon512.png'],
      workbox: {
        // Povećaj limit za precache ako imaš veće assets ili skrinšotove (npr. 4 MB)
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        globPatterns: ['**/*.{js,css,html,ico,png,jpg,svg,json,woff2}'],
        
        // Runtime keširanje za vanjske resurse (OpenStreetMap, Leaflet tiles, CDN fontovi)
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/[a-c]\.tile\.openstreetmap\.org\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'openstreetmap-tiles',
              expiration: {
                maxEntries: 500, // Keširaj do 500 pločica mape za offline rad
                maxAgeSeconds: 60 * 60 * 24 * 30 // 30 dana
              },
              cacheableResponse: {
                statuses: [0, 200] // 👈 Popravljeno: Dodane uglaste zagrade i statusi
              }
            }
          },
          {
            urlPattern: /^https:\/\/cdn\.jsdelivr\.net\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'cdn-scripts',
              expiration: {
                maxEntries: 30,
                maxAgeSeconds: 60 * 60 * 24 * 60
              },
              cacheableResponse: {
                statuses: [0, 200] // 👈 Popravljeno: Dodane uglaste zagrade i statusi
              }
            }
          }
        ]
      },
      manifest: {
        name: 'Terenska Evidencija',
        short_name: 'Evidencija',
        description: 'Offline geographic mapping and logging app',
        theme_color: '#0f172a',
        background_color: '#0f172a',
        display: 'standalone',
        orientation: 'portrait-primary',
        start_url: '/',
        scope: '/',
        icons: [
          {
            src: '/icon192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any'
          },
          {
            src: '/icon192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'maskable'
          },
          {
            src: '/icon512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any'
          },
          {
            src: '/icon512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable'
          }
        ],
        screenshots: [
          {
            src: '/screenshot-mobile.jpg',
            sizes: '508x776',
            type: 'image/jpeg',
            form_factor: 'narrow',
            label: 'Mobilni prikaz aplikacije'
          },
          {
            src: '/screenshot-desktop.jpg',
            sizes: '1918x877',
            type: 'image/jpeg',
            form_factor: 'wide',
            label: 'Desktop prikaz aplikacije'
          }
        ]
      }
    })
  ]
});
