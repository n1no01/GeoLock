import { defineConfig } from 'vitest/config';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 900
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.js'],
    setupFiles: ['test/setup.js']
  },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      includeAssets: [
        'favicon.ico',
        'favicon-16x16.png',
        'favicon-32x32.png',
        'apple-touch-icon.png',
        'icon192.png',
        'icon512.png',
        'icon192-maskable.png',
        'icon512-maskable.png'
      ],
      workbox: {
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        globPatterns: ['**/*.{js,css,html,ico,png,jpg,svg,json,woff2}'],
        cleanupOutdatedCaches: true,

        // Pločice mape se keširaju za offline rad. Tile servere se učitava sa crossOrigin
        // (vidi map.js), pa odgovori NISU "opaque" — opaque odgovori se u kvotu računaju sa
        // ~7 MB po zapisu, što bi brzo potrošilo prostor namijenjen podacima.
        // Napomena: masovno unaprijed preuzimanje OSM pločica krši njihovu tile politiku;
        // za ozbiljnu offline upotrebu koristite vlastiti/komercijalni tile izvor.
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/[a-c]\.tile\.openstreetmap\.org\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'openstreetmap-tiles',
              expiration: { maxEntries: 500, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [200] }
            }
          },
          {
            urlPattern: /^https:\/\/server\.arcgisonline\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'satellite-tiles',
              expiration: { maxEntries: 300, maxAgeSeconds: 60 * 60 * 24 * 14 },
              cacheableResponse: { statuses: [200] }
            }
          }
        ]
      },
      manifest: {
        id: '/',
        name: 'GeoLock',
        short_name: 'GeoLock',
        description: 'Offline terenska evidencija lokacija sa end-to-end enkripcijom',
        lang: 'bs',
        theme_color: '#0f172a',
        background_color: '#0f172a',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        icons: [
          { src: '/icon192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icon512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icon192-maskable.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: '/icon512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
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
