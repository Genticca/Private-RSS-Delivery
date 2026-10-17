import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve('src/server');
const TIERS: Record<string, number> = {
  core: 0, net: 1, feed: 1, logs: 2, templates: 3, groups: 4, sources: 5,
  translation: 6, delivery: 7, collect: 8, transfer: 9, cleanup: 9, web: 10,
  container: 11, app: 12, main: 13
};

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]);
}

function packageOf(file: string): string {
  const parts = relative(ROOT, file).split(sep);
  return parts.length === 1 ? parts[0].replace(/\.ts$/, '') : parts[0];
}

/** Keep comments and ordinary string contents out of the import scan. */
function tokens(source: string): string[] {
  const pattern = /\s+|\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`|[A-Za-z_$][\w$]*|=>|&&|\|\||[\s\S]/gy;
  const result: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    const token = match[0];
    if (/^\s|^\/\/|^\/\*/.test(token)) continue;
    // A regex literal may itself contain text resembling an import.
    if (token === '/' && (!result.length || ['=', '(', '[', '{', ',', ':', ';', 'return', '=>', '!', '&&', '||', '?'].includes(result.at(-1)!))) {
      let index = pattern.lastIndex;
      let inClass = false;
      while (index < source.length) {
        const char = source[index++];
        if (char === '\\') { index++; continue; }
        if (char === '[') inClass = true;
        if (char === ']') inClass = false;
        if (char === '/' && !inClass) break;
        if (char === '\n' || char === '\r') throw new Error('Unterminated regex literal');
      }
      while (/[a-z]/i.test(source[index] ?? '') && index < source.length) index++;
      pattern.lastIndex = index;
      result.push('/regex/');
      continue;
    }
    if (token.startsWith('`') && /\$\{[\s\S]*\bimport\s*\(/.test(token)) {
      throw new Error('Move imports out of template interpolations so dependencies can be checked');
    }
    result.push(token);
  }
  return result;
}

function literal(token: string | undefined): string | null {
  if (!token || !['"', "'", '`'].includes(token[0])) return null;
  if (token[0] === '`' && token.includes('${')) return null;
  return token.slice(1, -1).replace(/\\(?:u\{([\da-f]+)\}|u([\da-f]{4})|x([\da-f]{2})|(\r?\n)|([\s\S]))/gi,
    (_match, point: string, unicode: string, hex: string, newline: string, char: string) =>
      point || unicode || hex ? String.fromCodePoint(parseInt(point || unicode || hex, 16))
        : newline ? '' : ({ n: '\n', r: '\r', t: '\t' }[char] ?? char));
}

function specifiers(source: string): string[] {
  const parts = tokens(source);
  const result: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const token = parts[i];
    if (!['import', 'export'].includes(token) || parts[i - 1] === '.') continue;
    const next = parts[i + 1];
    if (token === 'import' && next === '.') continue; // import.meta
    if (token === 'import' && next === '(') {
      const value = literal(parts[i + 2]);
      if (value === null || ![')', ','].includes(parts[i + 3])) {
        throw new Error('Dynamic imports must use a literal module path');
      }
      result.push(value);
      continue;
    }
    const sideEffect = token === 'import' ? literal(next) : null;
    if (sideEffect !== null) { result.push(sideEffect); continue; }
    const exportStart = next === 'type' ? parts[i + 2] : next;
    if (token === 'export' && !['{', '*'].includes(exportStart)) continue;
    for (let j = i + 1; j < parts.length && parts[j] !== ';'; j++) {
      if (parts[j] === 'from' && literal(parts[j + 1]) !== null) {
        result.push(literal(parts[j + 1])!);
        break;
      }
    }
  }
  return result;
}

function targetOf(file: string, module: string): string | null {
  if (module.startsWith('file:')) return fileURLToPath(module).replace(/\.js$/, '.ts');
  const aliases: Record<string, string> = { '@server/': ROOT };
  for (const [prefix, dir] of Object.entries(aliases)) {
    if (module.startsWith(prefix)) return resolve(dir, module.slice(prefix.length)).replace(/\.js$/, '.ts');
  }
  return module.startsWith('.') || isAbsolute(module)
    ? resolve(dirname(file), module).replace(/\.js$/, '.ts') : null;
}

function insideRoot(file: string): boolean {
  const path = relative(ROOT, file);
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

describe('server package dependencies', () => {
  const allFiles = files(ROOT);
  const sources = allFiles.filter((file) => file.endsWith('.ts'));
  const edges = sources.flatMap((file) => specifiers(readFileSync(file, 'utf8'))
    .map((module) => targetOf(file, module))
    .filter((target): target is string => target !== null)
    .map((target) => ({ file, target })));
  const label = ({ file, target }: { file: string; target: string }) => `${relative(ROOT, file)} -> ${relative(ROOT, target)}`;

  it('imports each module once per file', () => {
    const duplicates = sources.flatMap((file) => {
      const statements = [...readFileSync(file, 'utf8').matchAll(/^import\s+(type\s+)?([^'"]*?)\s*from\s*['"]([^'"]+)['"]/gms)];
      const seen = new Map<string, number>();
      for (const [, typeOnly, clause, module] of statements) {
        if (clause.trim().startsWith('* as')) continue;
        const typeDefault = typeOnly && !clause.trim().startsWith('{');
        const key = `${module}${typeDefault ? ':type-default' : ''}`;
        seen.set(key, (seen.get(key) ?? 0) + 1);
      }
      return [...seen].filter(([, count]) => count > 1).map(([module]) => `${relative(ROOT, file)} -> ${module}`);
    });
    expect(duplicates).toEqual([]);
  });

  it('knows every package', () => {
    expect(sources.map(packageOf).filter((name) => !(name in TIERS))).toEqual([]);
  });

  it('resolves local imports within the server', () => {
    expect(edges.filter(({ target }) => !insideRoot(target) || !existsSync(target)).map(label)).toEqual([]);
  });

  it('imports only lower tiers across packages, including type imports and re-exports', () => {
    expect(edges.filter(({ file, target }) => packageOf(file) !== packageOf(target)
      && !(TIERS[packageOf(target)] < TIERS[packageOf(file)])).map(label)).toEqual([]);
  });

  it('keeps routes on top and repositories at the bottom of each package', () => {
    expect(edges.filter(({ file, target }) => file !== target && packageOf(file) === packageOf(target))
      .filter(({ file, target }) => target.endsWith(`${sep}routes.ts`)
        || (file.endsWith(`${sep}repository.ts`) && !target.endsWith(`${sep}repository.ts`)))
      .map(label)).toEqual([]);
  });

  it('has no barrel index files or empty-folder markers', () => {
    expect(allFiles.filter((file) => /(?:^|[\\/])(?:index\.ts|\.gitkeep)$/.test(file)).map((file) => relative(ROOT, file))).toEqual([]);
  });

  it('has no empty-folder markers anywhere in the repository', () => {
    const skip = new Set(['node_modules', '.git', 'dist', 'data']);
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? (skip.has(entry.name) ? [] : walk(join(dir, entry.name)))
        : entry.name === '.gitkeep' ? [relative(resolve('.'), join(dir, entry.name))] : []);
    expect(walk(resolve('.'))).toEqual([]);
  });

  it('keeps new modules at least 40 lines apart from route and cleanup exceptions', () => {
    expect(sources.filter((file) => !file.endsWith(`${sep}routes.ts`) && relative(ROOT, file) !== join('cleanup', 'worker.ts'))
      .filter((file) => readFileSync(file, 'utf8').trimEnd().split(/\r?\n/).length < 40)
      .map((file) => relative(ROOT, file))).toEqual([]);
  });
});

describe('dependency import scanning', () => {
  it.each([
    "import { value } from '../core/input.js';",
    'import type { Value } from "../core/input.js";',
    'import "../core/input.js";',
    'export { value } from "../core/input.js";',
    'export type { Value } from "../core/input.js";',
    'export * from "../core/input.js";',
    'const module = import("../core/input.js");',
    'type Value = import("../core/input.js").Value;',
    'const module = import(`../core/input.js`);',
    'import /* note */ { value }\n from /* note */ "../core/input.js";',
    'import { value } from "\\u002e./core/input.js";'
  ])('finds dependencies in %s', (source) => {
    expect(specifiers(source)).toEqual(['../core/input.js']);
  });

  it('ignores comments, quoted strings, regex contents and import.meta', () => {
    expect(specifiers(`// import('../fake.js')
      /* export * from '../fake.js'; */
      const text = "import('../fake.js')";
      const pattern = /import\\('fake'\\)/;
      const url = import.meta.url;`)).toEqual([]);
  });

  it('rejects computed imports that would evade the dependency rules', () => {
    expect(() => specifiers('import(moduleName)')).toThrow('literal module path');
    expect(() => specifiers('import(`../${name}.js`)')).toThrow('literal module path');
    expect(() => specifiers('import("../" + name)')).toThrow('literal module path');
  });

  it('checks aliases and uses a path boundary when locating the server root', () => {
    expect(targetOf(join(ROOT, 'web', 'pages.ts'), '@server/core/input.js')).toBe(join(ROOT, 'core', 'input.ts'));
    expect(insideRoot(`${ROOT}-other/file.ts`)).toBe(false);
  });
});
