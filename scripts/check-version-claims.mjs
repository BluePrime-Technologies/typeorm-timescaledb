#!/usr/bin/env node
/**
 * Fail the build when a public "what ships" surface still advertises an older release line.
 *
 * Why this exists. Four separate public surfaces were found advertising a superseded version, each
 * by accident rather than by a check: the README said "What's in 0.6.x" on the npm page for 0.7.0;
 * the 0.7.0 CHANGELOG entry claimed "no new feature surface" while the range held ten feature
 * commits; `docs/feature-status.md` — the file that calls itself "the public source of truth for
 * what typeorm-timescaledb ships" — stopped at 0.4.0 and never mentioned `push`/`pull`/`mix`; and
 * the docs site still carries 0.1–0.6 claims.
 *
 * `feature-status.md` is the conclusive case: it contains its own `## Review rule` section telling
 * maintainers to keep it current, and it drifted three releases anyway. A documented review rule is
 * not a control. This is the control.
 *
 * What it checks, per surface:
 *   - the current MAJOR.MINOR from packages/typeorm/package.json appears somewhere in the file, and
 *   - no OLDER major.minor is presented as the current line, via the phrasings that actually caused
 *     the misses (`What's in 0.6.x`, `Shipped in 0.4.0` as the last such heading, `0.1.x foundation
 *     release`, `the current 0.4.x scope`).
 *
 * Deliberately not a spell-check of prose. It answers one question — "does this page know which
 * release line is current?" — because that is the question every one of the four misses got wrong.
 * Historical references are fine and expected: a CHANGELOG must mention 0.1.0, and a release-scope
 * section for an old version should stay. Only a stale CURRENT-line claim fails.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');

const version = JSON.parse(read('packages/typeorm/package.json')).version;
const [major, minor] = version.split('.');
const line = `${major}.${minor}`; // e.g. "0.7"

/**
 * Surfaces that state what the package currently ships. Adding a new such page means adding it
 * here — an unlisted page is exactly how `feature-status.md` drifted unnoticed.
 *
 * `mustMentionLine` is the core assertion. `staleCurrentClaim` catches the phrasings that produced
 * the real misses, so the gate fails on the specific wording rather than on any mention of an old
 * version.
 */
const SURFACES = [
  {
    file: 'README.md',
    // The npm package page renders this file (copied in by packages/typeorm prepack), so a stale
    // heading here is the most publicly visible instance of this bug.
    staleCurrentClaim: [/What's in 0\.(?!7)\d+\.x/g, /\*\*Works today \(0\.(?!7)\d+\.x\)/g],
  },
  {
    file: 'CHANGELOG.md',
    // Must carry an entry for the version about to ship, or the release has no notes at all.
    requireHeading: new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\]`, 'm'),
  },
  {
    file: 'docs/feature-status.md',
    staleCurrentClaim: [
      /the current published release line \(0\.(?!7)\d+\.x\)/g,
      /shipped for the current 0\.(?!7)\d+\.x scope/g,
    ],
  },
  { file: 'docs/overview.md', staleCurrentClaim: [/0\.(?!7)\d+\.x foundation release/g] },
];

const failures = [];

for (const surface of SURFACES) {
  let text;
  try {
    text = read(surface.file);
  } catch {
    failures.push(`${surface.file}: listed as a version-claim surface but missing from the repo`);
    continue;
  }

  if (!text.includes(line)) {
    failures.push(
      `${surface.file}: never mentions the current release line ${line}.x — it cannot be describing what ${version} ships`,
    );
  }

  for (const pattern of surface.staleCurrentClaim ?? []) {
    const hits = [...text.matchAll(pattern)].map((m) => m[0]);
    if (hits.length > 0) {
      failures.push(
        `${surface.file}: presents an older line as current — ${[...new Set(hits)].map((h) => JSON.stringify(h)).join(', ')} (current is ${line}.x)`,
      );
    }
  }

  if (surface.requireHeading && !surface.requireHeading.test(text)) {
    failures.push(`${surface.file}: has no "## [${version}]" entry for the version being released`);
  }
}

if (failures.length > 0) {
  console.error(`\nversion-claim check FAILED for ${version}:\n`);
  for (const f of failures) console.error(`  ✕ ${f}`);
  console.error(
    `\nThese pages tell users what the package does. Shipping a release whose own docs\n` +
      `describe an older one is how the npm page for 0.7.0 came to advertise 0.6.x.\n` +
      `Update the page, or update SURFACES in scripts/check-version-claims.mjs if a page\n` +
      `genuinely no longer makes a current-line claim.\n`,
  );
  process.exit(1);
}

console.log(
  `version-claim check OK — ${SURFACES.length} surfaces all describe ${line}.x (v${version})`,
);
