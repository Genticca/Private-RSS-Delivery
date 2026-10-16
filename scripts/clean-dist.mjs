import { existsSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// tsc does not remove outputs for deleted source files. Only remove this project's generated dist.
const projectRoot = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const target = resolve(projectRoot, 'dist');
if (existsSync(target)) {
  const actual = realpathSync(target);
  if (actual !== target || dirname(actual) !== projectRoot || basename(actual) !== 'dist') {
    throw new Error('Refusing to clean a dist path outside the project or through a symbolic link.');
  }
  rmSync(actual, { recursive: true, force: true });
}
