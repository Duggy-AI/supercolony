import { chmod, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import JavaScriptObfuscator from 'javascript-obfuscator';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const files = await readdir(resolve(root, 'src'), { recursive: true });
await rm(resolve(root, 'dist'), { recursive: true, force: true });

// Preserve module paths for import.meta.url assets, lazy imports and TUI forks.
// Native dependencies stay external and are installed by npm on each platform.
for (const [extension, format] of [['.mjs', 'esm'], ['.cjs', 'cjs']]) {
  await build({
    absWorkingDir: root,
    entryPoints: files.filter(file => file.endsWith(extension)).map(file => resolve(root, 'src', file)),
    outbase: 'src', outdir: 'dist', outExtension: { '.js': extension },
    platform: 'node', target: 'node22', format,
    bundle: false, minify: true, sourcemap: false,
  });
}
for (const file of files.filter(file => /\.(mjs|cjs)$/.test(file)).sort()) {
  const output = resolve(root, 'dist', file);
  const source = await readFile(output, 'utf8');
  const result = JavaScriptObfuscator.obfuscate(source, {
    target: 'node', compact: true, seed: 1,
    identifierNamesGenerator: 'hexadecimal',
    ignoreImports: true, renameGlobals: false, renameProperties: false,
    stringArray: true, stringArrayThreshold: 0.75, stringArrayEncoding: [],
    stringArrayCallsTransform: false, stringArrayRotate: false,
    controlFlowFlattening: false, deadCodeInjection: false,
    debugProtection: false, selfDefending: false, disableConsoleOutput: false,
    sourceMap: false,
  });
  await writeFile(output, result.getObfuscatedCode());
}
await chmod(resolve(root, 'dist/cli.mjs'), 0o755);
console.error('Built minified and obfuscated runtime modules in dist/ (no source maps).');
