/**
 * The Node 20 deprecation notice.
 *
 * Node 20 reached END OF LIFE on 2026-04-30. The published packages still RUN on it — the floor was
 * briefly raised to `>=22.12.0` to unblock vitest 5, which is a devDependency: nothing in the
 * shipped runtime needs Node 22 (the build targets ES2022 and uses no 22-only API). Publishing a
 * tooling constraint as a runtime requirement broke consumers for a reason that had nothing to do
 * with them, so the range was restored and the removal scheduled instead.
 *
 * Why a CLI warning and not a warning on import. A library that warns from module scope writes into
 * every consumer's test output and every serverless cold start, cannot be suppressed without
 * swallowing unrelated output, and fires in processes whose operator never chose this dependency.
 * The CLI is the one place a human is watching, so that is where the notice lives.
 *
 * Why not rely on `engines` alone: npm treats `engines` as ADVISORY unless `engine-strict` is set,
 * so for most consumers a narrowed range produces a warning buried in install output — the break
 * without the message. This states the date and the version that removes it.
 */

/** The deprecated leg of `engines`: `^20.19.0` — i.e. >=20.19.0 and <21. */
export const DEPRECATED_NODE_MAJOR = 20;
const DEPRECATED_NODE_MIN_MINOR = 19;

/** The current leg of `engines`: `>=22.12.0`. */
export const SUPPORTED_NODE_MAJOR = 22;
const SUPPORTED_NODE_MIN_MINOR = 12;

/** The release that removes the deprecated leg. Named here so the message and docs cannot drift. */
export const NODE_SUPPORT_REMOVED_IN = '0.9.0';

/** Node 20's end-of-life date, per the official Node release schedule. */
export const NODE_20_EOL = '2026-04-30';

/** The exact range the packages declare. Single source for the message and the tests. */
export const SUPPORTED_NODE_RANGE = '^20.19.0 || >=22.12.0';

interface NodeVersion {
  readonly major: number;
  readonly minor: number;
}

/**
 * Parse `v20.19.0` / `20.19.0` into its major and minor.
 *
 * Returns `undefined` rather than guessing for anything unparseable — a nightly, a custom build, or
 * an embedder reporting something else. An unknown runtime gets no warning, because a deprecation
 * notice aimed at the wrong runtime is worse than silence.
 *
 * Minor is parsed, not just major: the range is `^20.19.0 || >=22.12.0`, so 20.1.0 and 22.11.0 are
 * BOTH outside it while sharing a major with versions that are inside. Comparing majors alone
 * called Node 21 "deprecated" when it was never supported at all.
 */
export function parseNodeVersion(version: string): NodeVersion | undefined {
  const m = /^v?(\d+)\.(\d+)(?:\.|$)/.exec(version);
  if (m === null) return undefined;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor)) return undefined;
  return { major, minor };
}

/** The major alone, or `undefined` when unparseable. */
export function nodeMajor(version: string): number | undefined {
  return parseNodeVersion(version)?.major;
}

/** Whether `version` satisfies the DEPRECATED leg (`^20.19.0`). */
export function isDeprecatedNode(version: string): boolean {
  const v = parseNodeVersion(version);
  return (
    v !== undefined && v.major === DEPRECATED_NODE_MAJOR && v.minor >= DEPRECATED_NODE_MIN_MINOR
  );
}

/** Whether `version` satisfies `engines` at all (either leg). */
export function isSupportedNode(version: string): boolean {
  const v = parseNodeVersion(version);
  if (v === undefined) return false;
  if (isDeprecatedNode(version)) return true;
  if (v.major > SUPPORTED_NODE_MAJOR) return true;
  return v.major === SUPPORTED_NODE_MAJOR && v.minor >= SUPPORTED_NODE_MIN_MINOR;
}

/**
 * The notice text for `version`, or `undefined` when none is warranted.
 *
 * Returns the STRING rather than printing: that is what makes it unit-testable without capturing a
 * stream, and it separates the decision ("is this runtime deprecated?") from the delivery.
 */
export function deprecatedNodeNotice(version: string): string | undefined {
  const v = parseNodeVersion(version);
  if (v === undefined) return undefined;
  if (isDeprecatedNode(version)) {
    return (
      `typeorm-timescaledb: Node ${version} is DEPRECATED. Node ${String(DEPRECATED_NODE_MAJOR)} ` +
      `reached end of life on ${NODE_20_EOL} and receives no security patches. ` +
      `Support is removed in ${NODE_SUPPORT_REMOVED_IN} — upgrade to Node ` +
      `${String(SUPPORTED_NODE_MAJOR)}.${String(SUPPORTED_NODE_MIN_MINOR)}.0 or newer.`
    );
  }
  if (!isSupportedNode(version)) {
    return (
      `typeorm-timescaledb: Node ${version} is NOT supported (requires ${SUPPORTED_NODE_RANGE}). ` +
      `Node ${String(DEPRECATED_NODE_MAJOR)} is deprecated and removed in ` +
      `${NODE_SUPPORT_REMOVED_IN}; upgrade to Node ` +
      `${String(SUPPORTED_NODE_MAJOR)}.${String(SUPPORTED_NODE_MIN_MINOR)}.0 or newer.`
    );
  }
  return undefined;
}

/**
 * Emit the notice once, on STDERR.
 *
 * stderr rather than stdout so a caller piping `check`/`pull` output into a file or a parser is
 * unaffected — the drift gate's exit code and its stdout are the contract, and a deprecation notice
 * must not become part of either.
 */
export function warnIfDeprecatedNode(
  version: string = process.version,
  warn: (message: string) => void = console.error,
): boolean {
  const notice = deprecatedNodeNotice(version);
  if (notice === undefined) return false;
  warn(notice);
  return true;
}
