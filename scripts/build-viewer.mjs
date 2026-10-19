import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { root } from './release-utils.mjs';

/** Bundle all browser code and Kumo's precompiled standalone CSS locally. */
export async function buildViewer(destination = path.join(root, 'dist/viewer')) {
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  const bundled = await build({
    absWorkingDir: root,
    entryPoints: { app: 'src/viewer/ui/main.tsx' },
    outdir: destination,
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: ['chrome111', 'firefox128', 'safari16.4'],
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    minify: true,
    sourcemap: false,
    legalComments: 'none',
    metafile: true,
  });
  const assetNames = Object.keys(bundled.metafile.outputs).map(output => path.basename(output)).sort();
  if (assetNames.join(',') !== 'app.css,app.js') throw new Error('Unexpected browser asset inventory: ' + assetNames.join(', '));
  for (const output of Object.values(bundled.metafile.outputs)) {
    for (const item of output.imports) {
      if (item.external) throw new Error('External browser dependency: ' + item.path);
    }
  }
  await cp(path.join(root, 'src/viewer/ui/index.html'), path.join(destination, 'index.html'));
  return bundled;
}

if (import.meta.main) {
  const result = await buildViewer();
  console.log(JSON.stringify({ viewer_assets: Object.keys(result.metafile.outputs).sort(), local_assets_only: true }));
}
