import esbuild from 'esbuild';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { buildNotices } from './build-notices.mjs';

const require = createRequire(import.meta.url);
const production = process.argv[2] === 'production';
const context = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  external: ['obsidian'],
  platform: 'browser',
  alias: { path: 'path-browserify' },
  inject: ['src/buffer-shim.ts'],
  loader: { '.svg': 'text' },
  format: 'cjs',
  target: 'es2021',
  outfile: 'main.js',
  sourcemap: production ? false : 'inline',
  minify: production,
  logLevel: 'info',
  banner: { js: '/* Generated plugin bundle. Source: src/. Third-party licenses: THIRD_PARTY_NOTICES.md. */' },
  plugins: [{
    name: 'redoc-standalone-source',
    setup(build) {
      build.onResolve({ filter: /^redoc-standalone-source$/ }, () => ({
        path: require.resolve('redoc/bundles/redoc.standalone.js'),
        namespace: 'redoc-source',
      }));
      build.onLoad({ filter: /.*/, namespace: 'redoc-source' }, async ({ path }) => ({
        contents: await readFile(path, 'utf8'),
        loader: 'text',
      }));
    },
  }],
});

if (production) {
  await context.rebuild();
  await context.dispose();
  await buildNotices();
} else {
  await context.watch();
}
