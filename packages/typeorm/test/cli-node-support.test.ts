import { describe, expect, it } from 'vitest';
import {
  DEPRECATED_NODE_MAJOR,
  NODE_20_EOL,
  NODE_SUPPORT_REMOVED_IN,
  deprecatedNodeNotice,
  isSupportedNode,
  nodeMajor,
  warnIfDeprecatedNode,
} from '../src/cli/node-support.js';

describe('nodeMajor', () => {
  it('reads the major from a process.version-shaped string, with or without the v', () => {
    expect(nodeMajor('v20.19.0')).toBe(20);
    expect(nodeMajor('22.12.0')).toBe(22);
    expect(nodeMajor('v24.3.1')).toBe(24);
  });

  it('returns undefined rather than guessing on anything unparseable', () => {
    // A deprecation notice aimed at a runtime we failed to identify is worse than silence, so
    // every one of these must yield NO warning rather than a defaulted major.
    for (const v of ['', 'v', 'node', 'vX.1.0', '20', 'v-1.0.0']) {
      expect(nodeMajor(v)).toBeUndefined();
    }
  });
});

describe('deprecatedNodeNotice', () => {
  it('warns on Node 20 and names the EOL date and the removing release', () => {
    const notice = deprecatedNodeNotice('v20.19.0');
    expect(notice).toBeDefined();
    expect(notice).toContain('DEPRECATED');
    // The date and the version are the whole point: "deprecated, upgrade sometime" is not
    // actionable, and if either drifts from the docs the notice becomes a lie.
    expect(notice).toContain(NODE_20_EOL);
    expect(notice).toContain(NODE_SUPPORT_REMOVED_IN);
  });

  it('is silent on every supported Node', () => {
    expect(deprecatedNodeNotice('v22.12.0')).toBeUndefined();
    expect(deprecatedNodeNotice('v22.19.0')).toBeUndefined();
    expect(deprecatedNodeNotice('v24.0.0')).toBeUndefined();
    expect(deprecatedNodeNotice('v26.1.0')).toBeUndefined();
  });

  it('is silent on an unidentifiable runtime', () => {
    expect(deprecatedNodeNotice('not-a-version')).toBeUndefined();
  });

  it('says NOT SUPPORTED, not merely deprecated, below the deprecated floor', () => {
    const notice = deprecatedNodeNotice('v18.20.0');
    expect(notice).toBeDefined();
    expect(notice).toContain('NOT supported');
    expect(notice).not.toContain('is DEPRECATED');
  });

  it('follows the engines range exactly at every boundary, minors included', () => {
    // `^20.19.0 || >=22.12.0`. Comparing majors alone got three of these wrong: it called Node 21
    // "deprecated" though it was never supported, and admitted 20.1.0 and 22.11.0 though both sit
    // outside the range while sharing a major with versions inside it.
    expect(deprecatedNodeNotice(`v${String(DEPRECATED_NODE_MAJOR)}.19.0`)).toContain('DEPRECATED');
    expect(deprecatedNodeNotice('v20.20.2')).toContain('DEPRECATED');
    expect(deprecatedNodeNotice('v20.18.9')).toContain('NOT supported');
    expect(deprecatedNodeNotice('v21.7.3')).toContain('NOT supported');
    expect(deprecatedNodeNotice('v22.11.0')).toContain('NOT supported');
    expect(deprecatedNodeNotice('v22.12.0')).toBeUndefined();
    expect(deprecatedNodeNotice('v23.0.0')).toBeUndefined();
  });

  it('isSupportedNode agrees with the declared range', () => {
    for (const ok of ['v20.19.0', 'v20.20.2', 'v22.12.0', 'v24.3.1', 'v26.0.0']) {
      expect(isSupportedNode(ok)).toBe(true);
    }
    for (const no of ['v18.20.0', 'v20.18.9', 'v21.7.3', 'v22.11.0', 'garbage']) {
      expect(isSupportedNode(no)).toBe(false);
    }
  });
});

describe('warnIfDeprecatedNode', () => {
  it('emits through the injected sink and reports that it warned', () => {
    const lines: string[] = [];
    expect(warnIfDeprecatedNode('v20.19.0', (m) => lines.push(m))).toBe(true);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Node v20.19.0');
  });

  it('emits nothing and reports false on a supported Node', () => {
    const lines: string[] = [];
    expect(warnIfDeprecatedNode('v22.12.0', (m) => lines.push(m))).toBe(false);
    expect(lines).toEqual([]);
  });
});

describe('prereleases are classified by release LINE, not by semver.satisfies', () => {
  // A DELIBERATE divergence, pinned here so it cannot silently flip to the strict reading.
  //
  // `semver.satisfies` excludes every prerelease from a range that does not name one — verified:
  // satisfies('22.12.0-rc.1', '^20.19.0 || >=22.12.0') === false, and so is '23.0.0-nightly…'.
  // npm applies exactly that to `engines` at install time.
  //
  // This notice must NOT, because the strict reading would tell someone on a Node 23 nightly —
  // NEWER than anything the range names — that their runtime is unsupported. A false alarm on a
  // capable runtime is the failure this module exists to avoid.
  it('warns on a Node 20 prerelease, because the Node 20 LINE is deprecated', () => {
    expect(deprecatedNodeNotice('v20.19.0-rc.1')).toContain('DEPRECATED');
    expect(isSupportedNode('v20.19.0-rc.1')).toBe(true);
  });

  it('stays silent on a current-or-newer prerelease', () => {
    expect(deprecatedNodeNotice('v22.12.0-rc.1')).toBeUndefined();
    expect(deprecatedNodeNotice('v23.0.0-nightly20260101')).toBeUndefined();
    expect(deprecatedNodeNotice('v24.0.0-rc.2')).toBeUndefined();
  });

  it('still reports unsupported when the LINE itself is unsupported', () => {
    expect(deprecatedNodeNotice('v20.18.9-rc.1')).toContain('NOT supported');
    expect(deprecatedNodeNotice('v21.0.0-rc.1')).toContain('NOT supported');
    expect(deprecatedNodeNotice('v22.11.0-rc.1')).toContain('NOT supported');
  });

  it('build metadata does not change the classification', () => {
    expect(deprecatedNodeNotice('v20.19.0+build.5')).toContain('DEPRECATED');
    expect(deprecatedNodeNotice('v22.12.0+build.5')).toBeUndefined();
  });
});
