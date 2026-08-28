import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
      if (typeof pkg.lintPlan !== 'function') throw new Error('missing lintPlan re-export (#222)');
      if (typeof pkg.assertSafeFragment !== 'function') throw new Error('missing assertSafeFragment re-export (#222)');
      if (typeof pkg.formatLintFindings !== 'function') throw new Error('missing formatLintFindings re-export (#222)');
      if (typeof pkg.isEmptyPlan !== 'function') throw new Error('missing isEmptyPlan re-export (#228)');
      if (!Array.isArray(pkg.ANALYZERS)) throw new Error('missing ANALYZERS re-export (#228)');
      if (typeof pkg.compilePlan !== 'function') throw new Error('missing compilePlan re-export (#228)');
      if (typeof pkg.classifyOperation !== 'function') throw new Error('missing classifyOperation re-export (#228)');
      if (typeof pkg.diffSchemaState !== 'function') throw new Error('missing diffSchemaState re-export (#228)');
      if (pkg.ANALYZERS.length === 0) throw new Error('ANALYZERS re-export is empty (#228)');
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
      if (typeof pkg.lintPlan !== 'function') throw new Error('missing lintPlan re-export (#222)');
      if (typeof pkg.assertSafeFragment !== 'function') throw new Error('missing assertSafeFragment re-export (#222)');
      if (typeof pkg.formatLintFindings !== 'function') throw new Error('missing formatLintFindings re-export (#222)');
      if (typeof pkg.isEmptyPlan !== 'function') throw new Error('missing isEmptyPlan re-export (#228)');
      if (!Array.isArray(pkg.ANALYZERS)) throw new Error('missing ANALYZERS re-export (#228)');
      if (typeof pkg.compilePlan !== 'function') throw new Error('missing compilePlan re-export (#228)');
      if (typeof pkg.classifyOperation !== 'function') throw new Error('missing classifyOperation re-export (#228)');
      if (typeof pkg.diffSchemaState !== 'function') throw new Error('missing diffSchemaState re-export (#228)');
      if (pkg.ANALYZERS.length === 0) throw new Error('ANALYZERS re-export is empty (#228)');
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
  assert(
    statSync(binPath).isFile() || statSync(binPath).isSymbolicLink(),
    'CLI bin is not executable',
  );
  run(binPath, ['--help'], { cwd: projectDir });

  // TYPE re-exports, checked against the .d.ts a consumer actually installs.
  //
  // This is here rather than in a test file because `packages/typeorm/tsconfig.json` has
  // `include: ['src/**/*']` — test files are NOT typechecked, so a type-only assertion written in
  // one is never verified by any gate. Dropping `PlanAdvisory` from the re-export produced zero
  // errors until this check existed. Types are erased at runtime, so the shipped declaration is the
  // only place the claim can be proven.
  const typeExports = [
    'Plan',
    'PlanStep',
    'PlanAdvisory',
    'LintFinding',
    'LintSeverity',
    'Analyzer',
    'DiffOptions',
    'CompiledPlan',
    'OperationSafety',
    'SafetyClass',
    'SchemaStateIR',
    'Operation',
    'OperationKind',
  ];
  // BOTH declarations: package.json routes `require` types to dist/cjs/index.d.ts, which this gate
  // previously never inspected — so a drift between the ESM and CJS declarations would have gone
  // unnoticed even though both ship.
  for (const rel of [join('dist', 'index.d.ts'), join('dist', 'cjs', 'index.d.ts')]) {
    const dts = readFileSync(join(projectDir, 'node_modules', 'typeorm-timescaledb', rel), 'utf8');
    for (const name of typeExports) {
      assert(
        new RegExp(`\\b${name}\\b`).test(dts),
        `installed typeorm-timescaledb/${rel} does not re-export type ${name} (#228)`,
      );
    }
  }

  // COMPILE FIXTURE — the gate that proves exports are USABLE, not merely present.
  //
  // The .d.ts token check above proves a name appears. It cannot prove a consumer can actually
  // annotate the workflow, and that distinction is not academic: `SchemaStateIR` and `Operation`
  // shipped "exported" while `diffSchemaState`'s own parameters and `PlanStep.operation` remained
  // unnameable from this package. Twice during this work a grep for a symbol matched a COMMENT in
  // index.ts and was misread as an export. Only a compiler settles it.
  //
  // This typechecks a consumer that imports ONLY the facade — never @blueprime/timescaledb-core —
  // so any symbol still needing the transitive dependency is a build failure here.
  run('npm', ['install', '--silent', '--no-audit', '--no-fund', 'typescript@5'], {
    cwd: projectDir,
  });

  writeSmokeFile(
    join(projectDir, 'tsconfig.smoke.json'),
    JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          module: 'nodenext',
          moduleResolution: 'nodenext',
          target: 'es2022',
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
        },
        files: ['type-smoke.ts'],
      },
      null,
      2,
    ),
  );

  writeSmokeFile(
    join(projectDir, 'type-smoke.ts'),
    `
      // Every symbol below MUST come from the one package a user installs.
      import type {
        SchemaStateIR, Plan, PlanStep, PlanAdvisory, DiffOptions, CompiledPlan,
        Operation, OperationKind, OperationSafety, SafetyClass,
        LintFinding, LintSeverity, Analyzer,
      } from 'typeorm-timescaledb';
      import { diffSchemaState, isEmptyPlan, classifyOperation, compilePlan, lintPlan, ANALYZERS } from 'typeorm-timescaledb';

      // The documented introspect -> diff -> classify -> compile -> lint workflow, fully annotated.
      declare const current: SchemaStateIR;
      declare const desired: SchemaStateIR;
      const options: DiffOptions = {};

      const plan: Plan = diffSchemaState(current, desired, options);
      const empty: boolean = isEmptyPlan(plan);

      // The sharp edge: naming what is INSIDE a Plan, one level deeper than Plan itself.
      const step: PlanStep | undefined = plan.steps[0];
      const op: Operation | undefined = step?.operation;
      const kind: OperationKind | undefined = op?.kind;
      const safety: OperationSafety | undefined = op ? classifyOperation(op) : undefined;
      const cls: SafetyClass | undefined = safety?.safety;

      // Advisories drive the exit code, so a deploy gate must be able to type them.
      const advisories: readonly PlanAdvisory[] = plan.advisories ?? [];
      const blocking = advisories.filter((a) => a.kind === 'not-expressible');

      const compiled: CompiledPlan = compilePlan(plan);
      const findings: LintFinding[] = lintPlan(plan);
      const sev: LintSeverity | undefined = findings[0]?.severity;
      const rules: readonly Analyzer[] = ANALYZERS;

      void empty; void kind; void cls; void blocking; void compiled; void sev; void rules;
    `,
  );

  run('npx', ['tsc', '-p', 'tsconfig.smoke.json'], { cwd: projectDir });
  console.log('Type-level compile fixture passed (facade-only imports).');

  console.log('Package smoke test passed.');
} finally {
  if (process.env.KEEP_PACKAGE_SMOKE_TMP !== '1') {
    rmSync(tmp, { recursive: true, force: true });
  } else {
    console.log(`Kept package smoke temp directory: ${tmp}`);
  }
}
