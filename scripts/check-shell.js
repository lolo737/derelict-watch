// Sanity check: every file the service worker pre-caches must exist,
// otherwise cache.addAll() fails and the app never works offline.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export function shellEntries() {
  const sw = readFileSync(fileURLToPath(new URL('../public/sw.js', import.meta.url)), 'utf8');
  const block = sw.match(/const SHELL = \[([\s\S]*?)\];/);
  if (!block) throw new Error('SHELL list not found in sw.js');
  return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

export function missingShellFiles() {
  const root = fileURLToPath(new URL('../public/', import.meta.url));
  return shellEntries().filter((p) => p !== './' && !existsSync(join(root, p)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const missing = missingShellFiles();
  if (missing.length) { console.error('Missing from public/:', missing); process.exit(1); }
  console.log(`All ${shellEntries().length} app-shell entries exist.`);
}
