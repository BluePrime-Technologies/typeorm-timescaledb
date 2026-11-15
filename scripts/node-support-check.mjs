#!/usr/bin/env node
/**
 * Prove the PUBLISHED artifact works on the Node that is running this script.
 *
 * Why this exists separately from `package-smoke-test.mjs`. The unit matrix cannot run on Node 20:
 * vitest 5 declares `engines: ^22.12.0 || ^24.0.0 || >=26.0.0`, and raising the floor to satisfy a
 * DEVDEPENDENCY is what briefly turned a tooling constraint into a published runtime requirement.
 * The range was restored and the removal scheduled — but "supported" has to mean "verified", not
 * "assumed", or this is exactly the untested public claim the version-claims gate exists to stop.
 *
 * So the deprecated leg is verified the only way it honestly can be: install the real tarballs on
 * that Node and exercise them. No vitest involved, so the toolchain's own floor is irrelevant.
 *
 * Run it under whichever Node you want to certify:
 *   node scripts/node-support-check.mjs        (after `pnpm build`)
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { stdio: 'pipe', encoding: 'utf8', ...opts });
}
function assert(cond, message) {
  if (!cond) {
    console.error(`node-support-check FAILED: ${message}`);
    process.exit(1);
  }
}
function tarballName(pkgJsonPath) {
  const { name, version } = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
  return `${name.replace('@', '').replace('/', '-')}-${version}.tgz`;
}

// Mirror packages/typeorm/src/cli/node-support.ts. Duplicated on purpose: this script must be
// runnable on a Node the workspace itself cannot install on, so it cannot import from the build.
const v = /^v?(\d+)\.(\d+)/.exec(process.version);
assert(v !== null, `could not parse process.version ${process.version}`);
const major = Number(v[1]);
const minor = Number(v[2]);
const isDeprecatedLeg = major === 20 && minor >= 19;
const isSupported = isDeprecatedLeg || major > 22 || (major === 22 && minor >= 12);

console.log(`node-support-check on ${process.version} (deprecated leg: ${isDeprecatedLeg})`);
assert(
  isSupported,
  `${process.version} is outside the declared range ^20.19.0 || >=22.12.0 — nothing to certify`,
);

const packDir = mkdtempSync(join(tmpdir(), 'tsdb-nodesupport-pack-'));
const projectDir = mkdtempSync(join(tmpdir(), 'tsdb-nodesupport-proj-'));
mkdirSync(packDir, { recursive: true });

const coreTarball = join(packDir, tarballName(join(root, 'packages/core/package.json')));
const typeormTarball = join(packDir, tarballName(join(root, 'packages/typeorm/package.json')));

run('pnpm', ['--dir', join(root, 'packages/core'), 'pack', '--pack-destination', packDir]);
run('pnpm', ['--dir', join(root, 'packages/typeorm'), 'pack', '--pack-destination', packDir]);
assert(existsSync(coreTarball), `expected core tarball at ${coreTarball}`);
assert(existsSync(typeormTarball), `expected typeorm tarball at ${typeormTarball}`);

writeFileSync(
  join(projectDir, 'package.json'),
  JSON.stringify({ name: 'node-support-check', private: true, type: 'module' }, null, 2),
);

run(
  'npm',
  [
    'install',
    '--silent',
    '--no-audit',
    '--no-fund',
    coreTarball,
    typeormTarball,
    'typeorm@0.3.20',
    'pg@8',
    'reflect-metadata@0.2.2',
  ],
  { cwd: projectDir },
);

// Exercise real logic, not just module resolution: a package can import cleanly and still be
// broken by a syntax or API level the runtime does not accept.
writeFileSync(
  join(projectDir, 'check.mjs'),
  `
import 'reflect-metadata';
import * as pkg from 'typeorm-timescaledb';
import * as core from '@blueprime/timescaledb-core';

if (typeof pkg.createTimescale !== 'function') throw new Error('missing createTimescale');
if (typeof pkg.diffSchemaState !== 'function') throw new Error('missing diffSchemaState re-export');
if (typeof core.createHypertableSQL !== 'function') throw new Error('missing core SQL export');

const d = \`SELECT time_bucket('01:00:00'::interval, "time") AS bucket, sensor_id, avg(value) AS avg_value
  FROM sensor_reading GROUP BY (time_bucket('01:00:00'::interval, "time")), sensor_id;\`;
const facets = core.extractCaggFacets(d);
if (facets === undefined) throw new Error('facet parser returned undefined on this runtime');
const wider = core.extractCaggFacets(d.replaceAll('01:00:00', '24:00:00'));
if (core.caggFacetsEqual(facets, wider)) throw new Error('drift not detected on this runtime');
console.log('runtime check OK');
`,
);
const out = run('node', ['check.mjs'], { cwd: projectDir });
assert(out.includes('runtime check OK'), `runtime check did not report OK: ${out}`);

// The deprecation notice must fire on the deprecated leg and stay silent elsewhere. A notice that
// never actually prints is the same as not having one.
const binPath = join(projectDir, 'node_modules', '.bin', 'typeorm-timescaledb');

// Capture STDERR specifically: the notice is written there on purpose so that piping `check`
// output into a parser stays unaffected. Redirecting stdout to /dev/null proves it is on the
// stream we claim, not merely somewhere in the output.
function cliStderr(args) {
  try {
    return execFileSync(`"${binPath}" ${args} 2>&1 1>/dev/null`, {
      cwd: projectDir,
      encoding: 'utf8',
      shell: true,
    });
  } catch (err) {
    return String(err.stdout ?? '') + String(err.stderr ?? '');
  }
}

const helpStderr = cliStderr('--help');

if (isDeprecatedLeg) {
  assert(
    helpStderr.includes('DEPRECATED'),
    `expected the CLI to warn on ${process.version}, got stderr: ${JSON.stringify(helpStderr)}`,
  );
  console.log('deprecation notice present on stderr');
} else {
  assert(
    !helpStderr.includes('DEPRECATED'),
    `CLI warned about deprecation on a current Node (${process.version}): ${JSON.stringify(helpStderr)}`,
  );
  console.log('no deprecation notice on a current Node, as expected');
}

console.log(`node-support-check passed on ${process.version}`);
