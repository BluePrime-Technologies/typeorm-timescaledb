// Mark the CJS output dir as CommonJS (the root package is "type": "module").
import { mkdirSync, writeFileSync } from 'node:fs';
mkdirSync('dist/cjs', { recursive: true });
writeFileSync('dist/cjs/package.json', `${JSON.stringify({ type: 'commonjs' }, null, 2)}\n`);
console.log('wrote dist/cjs/package.json {"type":"commonjs"}');
