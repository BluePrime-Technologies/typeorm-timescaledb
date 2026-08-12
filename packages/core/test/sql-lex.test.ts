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
