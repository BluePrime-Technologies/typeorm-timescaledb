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

/** Escape every regex metacharacter, not just the dot — a prerelease like `0.8.0-rc.1+build` puts a
 *  quantifier in the middle otherwise, and the heading check silently stops matching. */
function escapeRegExp(literal) {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The ONLY dependency-range forms {@link SURFACES}' `requireDependencyRange` will vouch for:
 * `^X.Y.Z`, `~X.Y.Z`, or a bare `X.Y.Z`.
 *
 * This replaced "read the first numeric pair out of the range", which passed `<0.7.0`: that string
 * contains `0.7`, so it read as current while npm could only install 0.6.x — the gate reporting
 * success on exactly the staleness it exists to catch. Comparators, unions (`>=0.7.0 <0.9.0`) and
 * dist-tags are now REFUSED rather than interpreted.
 *
 * Refusing is the right call over parsing. Deciding what `>=0.6.0 <0.8.0` "really means" for a
 * current-line claim is a judgement the gate should not be making silently, and there is no
 * legitimate reason for this repo's own example to depend on its own library through a comparator.
 *
 * Deliberately NOT using `semver`: it resolves here, but only as an undeclared hoisted transitive.
 * Depending on one from a script CI runs is the same defect this repo spent #222 and #228 removing,
 * and a lockfile change could take it away without warning.
 */
const PINNED_RANGE = /^([\^~]?)(\d+)\.(\d+)\.(\d+)$/;

/**
 * Build a pattern that matches "<prefix>0.N.x<suffix>" for any N that is NOT the current minor.
 *
 * The negative lookahead is DERIVED, never written in. Hardcoding `(?!7)` worked at 0.7 and would
 * have started flagging the CURRENT release line as stale the moment the version moved to 0.8 — the
 * same drift this whole gate exists to catch, in the gate itself.
 */
function staleLine(prefix, suffix = '\\.x') {
  return new RegExp(
    `${prefix}${escapeRegExp(major)}\\.(?!${escapeRegExp(minor)}\\b)\\d+${suffix}`,
    'g',
  );
}

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
    staleCurrentClaim: [staleLine("What's in "), staleLine('\\*\\*Works today \\(')],
  },
  {
    file: 'CHANGELOG.md',
    // Must carry an entry for the version about to ship, or the release has no notes at all.
    requireHeading: new RegExp(`^## \\[${escapeRegExp(version)}\\]`, 'm'),
  },
  {
    file: 'docs/feature-status.md',
    staleCurrentClaim: [
      staleLine('the current published release line \\('),
      staleLine('shipped for the current '),
    ],
  },
  { file: 'docs/overview.md', staleCurrentClaim: [staleLine('', ' foundation release')] },
  {
    // The quickstart is the first thing a newcomer runs, and it is the ONE surface nothing else can
    // notice rotting: `pnpm-workspace.yaml` excludes it (`- '!examples/quickstart'`), so it is never
    // installed, built, type-checked or exercised by CI. It sat on `^0.1.1` — six minor releases
    // behind, predating the migration engine its own scripts invoke — until a human happened to read
    // it. A prose check is the wrong instrument here; what matters is the dependency RANGE.
    file: 'examples/quickstart/package.json',
    requireDependencyRange: 'typeorm-timescaledb',
  },
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

  if (surface.requireDependencyRange !== undefined) {
    const name = surface.requireDependencyRange;
    let range;
    try {
      const pkg = JSON.parse(text);
      range = { ...pkg.dependencies, ...pkg.devDependencies }[name];
    } catch {
      failures.push(`${surface.file}: is not valid JSON, so its ${name} range cannot be checked`);
      continue;
    }
    if (range === undefined) {
      failures.push(`${surface.file}: declares no dependency on ${name}`);
    } else {
      const m = PINNED_RANGE.exec(range.trim());
      if (m === null) {
        failures.push(
          `${surface.file}: depends on ${name} ${JSON.stringify(range)}, which is not a form this ` +
            `gate will vouch for. Use ^${version}, ~${version} or ${version} — see PINNED_RANGE`,
        );
      } else if (m[2] !== major || m[3] !== minor) {
        failures.push(
          `${surface.file}: depends on ${name} ${JSON.stringify(range)}, which is not the current ` +
            `release line ${line}.x — anyone following the quickstart installs a version that ` +
            `predates most of what the docs describe`,
        );
      }
    }
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
