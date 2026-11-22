import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);

let compiler;
try {
  compiler = require.resolve('typescript/bin/tsc');
} catch {
  compiler = process.env.TSC_PATH;
}

if (!compiler || !existsSync(compiler)) {
  throw new Error('Install the dev dependencies or set TSC_PATH to the TypeScript compiler.');
}

const args = [compiler, '-p', join(root, 'tsconfig.json')];
if (!existsSync(join(root, 'node_modules', '@types', 'node'))) {
  args.push('--typeRoots', process.env.NODE_TYPES_ROOT || resolve(dirname(compiler), '../../@types'));
}
if (process.argv.includes('--check')) {
  args.push('--noEmit');
}

const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
