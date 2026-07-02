import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'typeorm-timescaledb-package-smoke-'));
const packDir = join(tmp, 'packs');
const projectDir = join(tmp, 'project');

function run(command, args, options = {}) {
  console.log(`$ ${[command, ...args].join(' ')}`);
  execFileSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: 'inherit',
    ...options,
  });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function packageTarballName(packageJsonPath) {
  const packageJson = readJson(packageJsonPath);
  const normalizedName = packageJson.name.replace(/^@/, '').replace('/', '-');
  return `${normalizedName}-${packageJson.version}.tgz`;
}

function listTarball(tarballPath) {
  const output = execFileSync('tar', ['-tzf', tarballPath], {
    encoding: 'utf8',
  });

  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function assertTarballShape(label, tarballPath, requiredEntries) {
  const entries = listTarball(tarballPath);

  for (const entry of requiredEntries) {
    assert(entries.includes(entry), `${label} tarball is missing ${entry}`);
  }

  const forbiddenEntries = entries.filter(
    (entry) => entry.startsWith('package/src/') || entry.includes('/src/'),
  );

  assert(
    forbiddenEntries.length === 0,
    `${label} tarball contains source files: ${forbiddenEntries.join(', ')}`,
  );
}

function writeSmokeFile(path, content) {
  writeFileSync(path, `${content.trim()}\n`);
}

mkdirSync(packDir, { recursive: true });
mkdirSync(projectDir, { recursive: true });

try {
  const coreTarball = join(packDir, packageTarballName(join(root, 'packages/core/package.json')));
  const typeormTarball = join(
    packDir,
    packageTarballName(join(root, 'packages/typeorm/package.json')),
  );

  run('pnpm', ['--dir', join(root, 'packages/core'), 'pack', '--pack-destination', packDir]);
  run('pnpm', ['--dir', join(root, 'packages/typeorm'), 'pack', '--pack-destination', packDir]);

  assert(existsSync(coreTarball), `Expected core tarball at ${coreTarball}`);
  assert(existsSync(typeormTarball), `Expected TypeORM tarball at ${typeormTarball}`);

  assertTarballShape('core', coreTarball, [
    'package/package.json',
    'package/dist/index.js',
    'package/dist/index.d.ts',
    'package/dist/cjs/index.js',
    'package/dist/cjs/index.d.ts',
  ]);

  assertTarballShape('typeorm', typeormTarball, [
    'package/package.json',
    'package/dist/index.js',
    'package/dist/index.d.ts',
    'package/dist/cjs/index.js',
    'package/dist/cjs/index.d.ts',
    'package/dist/nestjs/index.js',
    'package/dist/nestjs/index.d.ts',
    'package/dist/cjs/nestjs/index.js',
    'package/dist/cjs/nestjs/index.d.ts',
    'package/dist/cli/main.js',
  ]);

  writeFileSync(
    join(projectDir, 'package.json'),
    JSON.stringify(
      {
        name: 'typeorm-timescaledb-package-smoke',
        private: true,
        type: 'module',
      },
      null,
      2,
    ),
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
      '@nestjs/common@11',
      '@nestjs/core@11',
      'rxjs@7',
    ],
    { cwd: projectDir },
  );

  writeSmokeFile(
    join(projectDir, 'esm-smoke.mjs'),
    `
      import * as pkg from 'typeorm-timescaledb';
      import * as nest from 'typeorm-timescaledb/nestjs';
      import * as core from '@blueprime/timescaledb-core';

      if (typeof pkg.createTimescale !== 'function') throw new Error('missing createTimescale export');
      if (typeof pkg.Hypertable !== 'function') throw new Error('missing Hypertable export');
      if (typeof pkg.TimeColumn !== 'function') throw new Error('missing TimeColumn export');
      if (typeof pkg.assertSchema !== 'function') throw new Error('missing assertSchema export');
      if (typeof pkg.toNumber !== 'function') throw new Error('missing query result helper export');
      if (typeof nest.TimescaleModule !== 'function') throw new Error('missing NestJS module export');
      if (typeof core.createHypertableSQL !== 'function') throw new Error('missing core SQL export');
    `,
  );

  writeSmokeFile(
    join(projectDir, 'cjs-smoke.cjs'),
    `
      const pkg = require('typeorm-timescaledb');
      const nest = require('typeorm-timescaledb/nestjs');
      const core = require('@blueprime/timescaledb-core');

      if (typeof pkg.createTimescale !== 'function') throw new Error('missing createTimescale export');
      if (typeof pkg.Hypertable !== 'function') throw new Error('missing Hypertable export');
      if (typeof pkg.TimeColumn !== 'function') throw new Error('missing TimeColumn export');
      if (typeof pkg.assertSchema !== 'function') throw new Error('missing assertSchema export');
      if (typeof pkg.toNumber !== 'function') throw new Error('missing query result helper export');
      if (typeof nest.TimescaleModule !== 'function') throw new Error('missing NestJS module export');
      if (typeof core.createHypertableSQL !== 'function') throw new Error('missing core SQL export');
    `,
  );

  run('node', ['esm-smoke.mjs'], { cwd: projectDir });
  run('node', ['cjs-smoke.cjs'], { cwd: projectDir });

  const binPath = join(
    projectDir,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'typeorm-timescaledb.cmd' : 'typeorm-timescaledb',
  );

  assert(existsSync(binPath), `Expected CLI bin at ${binPath}`);
  assert(statSync(binPath).isFile() || statSync(binPath).isSymbolicLink(), 'CLI bin is not executable');
  run(binPath, ['--help'], { cwd: projectDir });

  console.log('Package smoke test passed.');
} finally {
  if (process.env.KEEP_PACKAGE_SMOKE_TMP !== '1') {
    rmSync(tmp, { recursive: true, force: true });
  } else {
    console.log(`Kept package smoke temp directory: ${tmp}`);
  }
}
