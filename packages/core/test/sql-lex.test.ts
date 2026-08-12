import { describe, expect, it } from 'vitest';
import {
  findUnquotedToken,
  assertSafeFragment,
  TimescaleErrorCode,
  type TimescaleError,
} from '../src/index.js';
// Not part of the public barrel — it is an internal builder concern, imported here because these
// cases exist to prove the two callers of the shared lexer still behave differently on purpose.
import { classifyDefinitionBody } from '../src/sql/continuous-aggregate.js';

/**
 * One lexer, two callers. These cases are the ones that made a second, naive implementation wrong:
 * a dangerous token INSIDE a literal is not dangerous, and the first version of
 * `assertSafeFragment` rejected exactly these legal expressions.
 */
describe('findUnquotedToken', () => {
  const FRAGMENT_TOKENS = [';', '--', '/*'];

  it('ignores a token inside a single-quoted literal', () => {
    expect(findUnquotedToken("string_agg(message, '--')", FRAGMENT_TOKENS)).toEqual({
      kind: 'clean',
    });
    expect(findUnquotedToken("count(*) FILTER (WHERE tag <> 'a;b')", FRAGMENT_TOKENS)).toEqual({
      kind: 'clean',
    });
    expect(findUnquotedToken("to_char(ts, 'HH24/*MI')", FRAGMENT_TOKENS)).toEqual({
      kind: 'clean',
    });
  });

  it("treats '' as an escaped quote rather than the end of the literal", () => {
    // If `''` closed the literal, the scanner would leave it and see the `;` as top level.
    expect(findUnquotedToken("f('it''s ; fine')", FRAGMENT_TOKENS)).toEqual({ kind: 'clean' });
  });

  it('ignores a token inside a double-quoted identifier, including one holding a single quote', () => {
    // The desync this state exists for: without it the scanner enters "literal" at the quote inside
    // "a'b" and stays there past a real separator.
    expect(findUnquotedToken(`avg("a'b")`, FRAGMENT_TOKENS)).toEqual({ kind: 'clean' });
    expect(findUnquotedToken(`avg("we;ird")`, FRAGMENT_TOKENS)).toEqual({ kind: 'clean' });
  });

  it('finds a token at top level and reports where', () => {
    expect(findUnquotedToken('avg(v); DROP TABLE t', FRAGMENT_TOKENS)).toEqual({
      kind: 'found',
      token: ';',
      index: 6,
    });
    expect(findUnquotedToken('avg(v) -- rest', FRAGMENT_TOKENS)).toEqual({
      kind: 'found',
      token: '--',
      index: 7,
    });
  });

  it('reports a token that follows a closed literal', () => {
    expect(findUnquotedToken("f('safe'); DROP TABLE t", FRAGMENT_TOKENS)).toEqual({
      kind: 'found',
      token: ';',
      index: 9,
    });
  });

  it('rejects a dollar-quote tag starting with a digit, which PostgreSQL would not read as a quote', () => {
    // `$1$ ; $1$` is not a dollar-quoted block, so the `;` inside it is a real separator.
    expect(findUnquotedToken('SELECT 1 $1$ ; $1$', [';'])).toMatchObject({ kind: 'found' });
    // A legal tag IS a quote, so the same `;` is inert.
    expect(findUnquotedToken('SELECT 1 $tag$ ; $tag$', [';'])).toEqual({ kind: 'clean' });
    expect(findUnquotedToken('SELECT 1 $$ ; $$', [';'])).toEqual({ kind: 'clean' });
  });

  it("treats a backslash-escaped quote inside an E'' escape string as escaped", () => {
    // Measured on PostgreSQL 17: SELECT E'foo\'--bar' is the single string foo'--bar. Closing the
    // literal at that inner quote made the following `--` look top level.
    expect(findUnquotedToken("string_agg(message, E'foo\\'--bar')", FRAGMENT_TOKENS)).toEqual({
      kind: 'clean',
    });
    expect(findUnquotedToken("f(E'a\\';DROP TABLE t;')", FRAGMENT_TOKENS)).toEqual({
      kind: 'clean',
    });
  });

  it('does NOT apply the backslash rule to a plain literal, where standard_conforming_strings makes it ordinary', () => {
    // Verified `standard_conforming_strings = on`, so 'a\' really does end at that quote and the
    // following `;` is a real separator. Treating it as escaped here would be the dangerous
    // direction — it would skip past live SQL.
    expect(findUnquotedToken("f('a\\'); DROP TABLE t", FRAGMENT_TOKENS)).toMatchObject({
      kind: 'found',
      token: ';',
    });
  });

  it('does not mistake an identifier ending in e for an escape-string prefix', () => {
    // `value'...'` is not an E-string; a backslash inside it is an ordinary character, so the
    // literal ends at the next quote and the `;` after it is real.
    expect(findUnquotedToken("value'a\\'; DROP TABLE t", FRAGMENT_TOKENS)).toMatchObject({
      kind: 'found',
      token: ';',
    });
  });

  it('nests block comments the way PostgreSQL does', () => {
    // Measured: SELECT /* a /* b */ still_comment */ 42 returns 42, and
    // SELECT 1 /* a /* b */ ; */ + 1 returns 2 — the inner close does not end the outer comment.
    expect(findUnquotedToken('avg(v) /* a /* b */ ; */ , sum(v)', [';'])).toEqual({
      kind: 'clean',
    });
    // An outer comment left open is still unterminated even though an inner one closed.
    expect(findUnquotedToken('avg(v) /* a /* b */ unclosed', [';'])).toEqual({
      kind: 'unterminated',
    });
    // A separator AFTER a fully closed nested comment is still found.
    expect(findUnquotedToken('avg(v) /* a /* b */ c */ ; DROP TABLE t', [';'])).toMatchObject({
      kind: 'found',
      token: ';',
    });
  });

  it('does not open a dollar quote when the $ continues an identifier', () => {
    // Measured on PostgreSQL 17: `SELECT 1 AS x$t$ ; $t$` errors with "unterminated dollar-quoted
    // string" pointing at the SECOND $t$ — so the server lexed `x$t$` as the identifier `x$t$` and
    // read the `;` as a real separator. Treating `$t$ … $t$` as a quoted block called that clean,
    // which is the dangerous direction: it would pass a separator, and anything after it, as inert.
    expect(findUnquotedToken('x$t$ ; $t$', [';'])).toMatchObject({ kind: 'found', token: ';' });
    expect(findUnquotedToken('SELECT 1 AS x$t$ ; DROP TABLE victim; $t$', [';'])).toMatchObject({
      kind: 'found',
      token: ';',
    });
    // A tag NOT preceded by an identifier character still opens a block, as before.
    expect(findUnquotedToken('avg(v), $t$ ; $t$', [';'])).toEqual({ kind: 'clean' });
    expect(findUnquotedToken('$t$ ; $t$', [';'])).toEqual({ kind: 'clean' });
    // Same rule for the E-prefix: an identifier ending in `e` is not an escape-string prefix.
    expect(findUnquotedToken("ab$e'x\\'; DROP", [';'])).toMatchObject({
      kind: 'found',
      token: ';',
    });
  });

  it('does not step past the end on a trailing backslash', () => {
    // `i += 2` over a backslash at the very end must not lose termination detection or throw.
    expect(findUnquotedToken("E'abc\\", [';'])).toEqual({ kind: 'unterminated' });
    expect(findUnquotedToken("E'abc\\\\", [';'])).toEqual({ kind: 'unterminated' });
    expect(findUnquotedToken("E'abc\\'", [';'])).toEqual({ kind: 'unterminated' });
    expect(findUnquotedToken("E'abc\\\\'", [';'])).toEqual({ kind: 'clean' });
  });

  it('treats a non-ASCII identifier character as part of the identifier', () => {
    // Measured on PostgreSQL 17: `SELECT 1 AS α$t$ ; $t$` gives the same "unterminated
    // dollar-quoted string" error against the SECOND $t$ as its ASCII twin, so α is an identifier
    // character and the `;` is a real separator. An ASCII-only check opened a block and hid it.
    expect(findUnquotedToken('α$t$ ; $t$', [';'])).toMatchObject({ kind: 'found', token: ';' });
    expect(findUnquotedToken('SELECT 1 AS α$t$ ; DROP TABLE victim; $t$', [';'])).toMatchObject({
      kind: 'found',
      token: ';',
    });
    // Same for the E-prefix: `βE'…'` is the identifier `βE` followed by a PLAIN literal, in which a
    // backslash is ordinary — so the literal ends at the next quote and the `;` after it is real.
    expect(findUnquotedToken("βE'foo\\'; DROP TABLE victim", [';'])).toMatchObject({
      kind: 'found',
      token: ';',
    });
    // A tag after punctuation still opens a block.
    expect(findUnquotedToken('α, $t$ ; $t$', [';'])).toEqual({ kind: 'clean' });
  });

  it('ends a line comment at a bare carriage return, as PostgreSQL does', () => {
    // Measured: `SELECT 'first' -- comment\r; SELECT 'SECOND_RAN'` runs BOTH statements, so the CR
    // ends the comment. Searching only for \n treated the rest as commented and hid the separator.
    expect(findUnquotedToken('avg(v) -- comment\r; DROP TABLE victim', [';'])).toMatchObject({
      kind: 'found',
      token: ';',
    });
    // CRLF was always fine (it contains a \n) and must stay fine.
    expect(findUnquotedToken('avg(v) -- comment\r\n; DROP TABLE victim', [';'])).toMatchObject({
      kind: 'found',
      token: ';',
    });
    // A `;` genuinely inside the comment is still inert.
    expect(findUnquotedToken('avg(v) -- comment ; still comment\n, sum(v)', [';'])).toEqual({
      kind: 'clean',
    });
  });

  it('reports unterminated states, but treats a line comment to end-of-input as clean', () => {
    expect(findUnquotedToken("f('unclosed", [';'])).toEqual({ kind: 'unterminated' });
    expect(findUnquotedToken('f("unclosed', [';'])).toEqual({ kind: 'unterminated' });
    expect(findUnquotedToken('f(1) /* unclosed', [';'])).toEqual({ kind: 'unterminated' });
    expect(findUnquotedToken('f(1) $tag$ unclosed', [';'])).toEqual({ kind: 'unterminated' });
    // A caller appending after a newline clears a line comment, so it is not "unterminated".
    expect(findUnquotedToken('f(1) -- trailing', [';'])).toEqual({ kind: 'clean' });
  });

  it('lets a caller skip comments instead of flagging them, which is how the two callers differ', () => {
    // classifyDefinitionBody's contract: a view body may contain comments; only `;` is structural.
    expect(findUnquotedToken('avg(v) -- note\n, sum(v)', [';'])).toEqual({ kind: 'clean' });
    expect(findUnquotedToken('avg(v) /* note ; not a separator */, sum(v)', [';'])).toEqual({
      kind: 'clean',
    });
  });
});

describe('assertSafeFragment accepts legal SQL that the naive guard refused', () => {
  it.each([
    "string_agg(message, '--')",
    "count(*) FILTER (WHERE tag <> 'a;b')",
    "to_char(ts, 'HH24;MI')",
    "avg(v) FILTER (WHERE note <> '/* not a comment */')",
    `avg("odd;name")`,
  ])('accepts %s', (fragment) => {
    expect(() => assertSafeFragment(fragment, 'aggExpr')).not.toThrow();
  });

  it.each([
    ['avg(v); DROP TABLE t', ';'],
    ['avg(v) -- swallow the rest', '--'],
    ['avg(v) /* swallow', '/*'],
  ])('still refuses %s', (fragment) => {
    expect(() => assertSafeFragment(fragment, 'aggExpr')).toThrow();
  });

  it('reports UNSAFE_FRAGMENT, not UNSAFE_IDENTIFIER — a fragment is composed SQL, not a name', () => {
    try {
      assertSafeFragment('avg(v); DROP TABLE t', 'aggExpr');
      throw new Error('expected throw');
    } catch (error) {
      expect((error as TimescaleError).code).toBe(TimescaleErrorCode.UNSAFE_FRAGMENT);
    }
  });

  it('refuses a fragment ending inside an unterminated literal', () => {
    // Whatever is composed after this lands inside the literal.
    expect(() => assertSafeFragment("f('unclosed", 'aggExpr')).toThrow(/unterminated/);
  });
});

describe('classifyDefinitionBody still holds after delegating to the shared lexer', () => {
  it('accepts a legal body whose literal contains a semicolon', () => {
    expect(classifyDefinitionBody("SELECT string_agg(x, ';') FROM t")).toBe('usable');
  });

  it('accepts a body containing comments', () => {
    expect(classifyDefinitionBody('SELECT 1 -- note\n FROM t')).toBe('usable');
  });

  it('rejects a real second statement', () => {
    expect(classifyDefinitionBody('SELECT 1 FROM t; DROP TABLE victim')).toBe('multi-statement');
  });

  it('rejects the quoted-identifier desync that once smuggled a DROP through', () => {
    expect(
      classifyDefinitionBody(`SELECT "a'b" FROM t; DROP TABLE victim; SELECT "c'd" FROM u`),
    ).toBe('multi-statement');
  });

  it('rejects a digit-leading dollar-quote tag hiding a separator', () => {
    expect(classifyDefinitionBody('SELECT 1 $1$ ; $1$')).toBe('multi-statement');
  });

  it('reports empty and unterminated distinctly', () => {
    expect(classifyDefinitionBody('')).toBe('empty');
    expect(classifyDefinitionBody('SELECT 1 /* unclosed')).toBe('unterminated');
  });
});
