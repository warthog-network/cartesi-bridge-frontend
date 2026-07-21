// astro.config.mjs
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import netlify from '@astrojs/netlify';
import node from '@astrojs/node';
import path from 'path';
import { fileURLToPath } from 'url';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const ethersV6Entry = path.resolve(projectRoot, 'node_modules/ethers-v6/lib.esm/index.js');
const cryptoShim = path.resolve(projectRoot, 'src/shims/crypto.js');
const processShim = path.resolve(projectRoot, 'src/shims/process.js');

// VPS/local Node host: ASTRO_ADAPTER=node  (default remains Netlify for deploys)
const useNodeAdapter = process.env.ASTRO_ADAPTER === 'node';

export default defineConfig({
  output: 'server',
  integrations: [react()],
  adapter: useNodeAdapter
    ? node({ mode: 'standalone' })
    : netlify({
        functionPerRoute: false,
        cacheOnDemandPages: true,
      }),
  // When serving on the VPS (Node adapter), bind all interfaces so nginx can
  // reach 127.0.0.1:4321. Netlify builds ignore this for deploys.
  server: useNodeAdapter
    ? { host: true, port: 4321 }
    : { host: false, port: 4321 },
  vite: {
    worker: {
      format: 'es',
    },
    define: {
      global: 'globalThis',
      'process.env': {},
    },
    resolve: {
      // Prefer warthog-js's nested ethers@6 over root ethers@5 when both exist.
      // Without this, Vite prebundles root ethers@5 into /node_modules/.vite/deps/ethers.js
      // and warthog-js's `import { SigningKey } from "ethers"` fails (SigningKey is v6-only).
      dedupe: ['ethers'],
      alias: {
        // Force ALL bare "ethers" imports (including warthog-js) onto ethers v6.
        // App code that needs v6 should import from 'ethers-v6' (same entry).
        // Root package "ethers" stays at v5 in package.json for any leftover utils usage,
        // but the browser bundle always gets v6.
        ethers: ethersV6Entry,
        'ethers-v6': ethersV6Entry,

        // Pure-ESM crypto shim — NEVER load crypto-browserify (CJS exports/require)
        crypto: cryptoShim,
        'node:crypto': cryptoShim,
        'crypto-browserify': cryptoShim,

        buffer: path.resolve(projectRoot, 'node_modules/buffer'),
        process: processShim,
        stream: path.resolve(projectRoot, 'node_modules/stream-browserify'),
        vm: path.resolve(projectRoot, 'node_modules/vm-browserify'),
        '@': path.resolve(projectRoot, 'src'),
      },
    },
    optimizeDeps: {
      include: [
        'buffer',
        'elliptic',
        'ethers',
        'ethers-v6',
        '@noble/hashes/sha2.js',
        '@noble/hashes/hmac.js',
        '@noble/hashes/pbkdf2.js',
      ],
      exclude: [
        'warthog-js',
        'crypto-browserify',
      ],
      esbuildOptions: {
        define: {
          global: 'globalThis',
        },
      },
    },
    ssr: {
      external: ['warthog-js'],
      noExternal: [],
    },
    server: {
      proxy: {
        '/rollup': {
          target: 'http://127.0.0.1:8080',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/rollup/, ''),
        },
      },
    },
    build: {
      commonjsOptions: {
        transformMixedEsModules: true,
      },
    },
  },
});
