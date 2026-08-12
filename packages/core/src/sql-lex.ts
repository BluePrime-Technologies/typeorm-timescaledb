/**
 * The one place this library decides whether a piece of SQL text is "in a literal or comment".
 *
 * There were two implementations of this walk, and that is the bug this module exists to prevent.
 * `classifyDefinitionBody` had a carefully-built scanner — single-quoted literals with `''`
 * escapes, double-quoted identifiers with `""` escapes, both comment forms, dollar quotes with the
 * correct unquoted-identifier tag rule — arrived at by fixing three separate smuggling bugs. Then
 * `assertSafeFragment` was added later and tested the raw text with a bare three-alternative regex
 * over semicolon and both comment openers — the naive form whose wrongness the other scanner's own
 * docstring already spells out: `string_agg(x, ';')` and
 * `string_agg(message, '--')` are legal SQL, and rejecting them refuses valid input while claiming
 * a reason that is false.
 *
 * `config.ts` names this failure mode exactly, about a different pair of parsers: "two parsers
 * disagreeing about what a token IS, which is the classic bug in this shape. Sharing the tables
 * means they cannot drift apart rather than merely happening to agree today." Same fix here — one
 * walk, two callers, no second opinion to keep in sync.
 */

/** Where the first requested token appears outside any literal or comment, if it does at all. */
export type LexResult =
  | { readonly kind: 'found'; readonly token: string; readonly index: number }
  /**
   * The text ends inside an unterminated string literal, quoted identifier, block comment or
   * dollar-quoted block, so anything a caller appends lands INSIDE it. An unterminated LINE comment
   * is deliberately not this: a caller that appends after a newline clears it, which is why
   * `createContinuousAggregateRawSQL` appends `\nWITH NO DATA;` rather than ` WITH NO DATA;`.
   */
  | { readonly kind: 'unterminated' }
  | { readonly kind: 'clean' };

/**
 * Find the first of `tokens` that appears in `text` at top level — not inside a string literal,
 * quoted identifier, or comment.
 *
 * `tokens` are matched BEFORE the skip states, so a caller can ask about the comment OPENERS
 * themselves (an expression fragment must reject a comment that would swallow the rest of the
 * generated expression) while another caller treats those as regions to skip (a view body may
 * legally contain comments). That ordering is the whole reason one walk can serve both.
 */
/**
 * True if the quote at `quoteIndex` opens an E-prefixed escape string (`E'…'`), where a backslash
 * escapes the following character.
 *
 * The character before the quote must be `E`/`e` AND must itself not be part of a longer word —
 * otherwise a column called `value` followed by a literal (`value'x'`, or any identifier ending in
 * `e`) would be misread as an escape string, and a backslash inside it would then be treated as an
 * escape rather than the ordinary character it is.
 */
function isEscapeStringPrefix(text: string, quoteIndex: number): boolean {
  const prev = text[quoteIndex - 1];
  if (prev !== 'E' && prev !== 'e') return false;
  return !isIdentifierChar(text[quoteIndex - 2]);
}

/**
 * Index of the first line-feed or carriage-return at or after `from`, or `-1`.
 *
 * Both, because PostgreSQL ends a `--` comment at either — see the note at the line-comment state.
 * Landing on the `\r` of a CRLF pair is harmless: the scan resumes on the `\n`, which is ordinary
 * whitespace at top level.
 */
function indexOfLineEnd(text: string, from: number): number {
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\n' || ch === '\r') return i;
  }
  return -1;
}

/**
 * True if `ch` can appear inside a PostgreSQL identifier. `$` is included: it is legal in an
 * identifier everywhere except the first position, which is exactly why a `$` following one does not
 * open a dollar-quoted string.
 *
 * `undefined` (start of input) is not an identifier character, so a construct at position 0 is
 * treated as opening one.
 */
function isIdentifierChar(ch: string | undefined): boolean {
  if (ch === undefined) return false;
  // Non-ASCII counts. PostgreSQL allows non-ASCII letters in an UNQUOTED identifier, and an
  // ASCII-only test was a bypass: `SELECT 1 AS α$t$ ; $t$` produces the same "unterminated
  // dollar-quoted string" error against the SECOND `$t$` as its ASCII twin (measured on 17), so `α`
  // is an identifier character and the `;` is a real separator — but the scan saw `α` as a
  // non-identifier, opened a `$t$…$t$` block, and swallowed the separator.
  //
  // Treating every byte >= 0x80 as an identifier character is the CONSERVATIVE side of the
  // remaining ambiguity: it can only make the scan open FEWER dollar quotes and classify FEWER
  // E-strings, i.e. stay at top level more often, which refuses valid SQL rather than hiding a
  // separator. Getting the exact set right would mean encoding-aware character classification.
  return /[A-Za-z0-9_$]/.test(ch) || (ch.codePointAt(0) ?? 0) >= 0x80;
}

export function findUnquotedToken(text: string, tokens: readonly string[]): LexResult {
  let i = 0;
  while (i < text.length) {
    // Caller's tokens win over the skip states — see the note above.
    for (const token of tokens) {
      if (text.startsWith(token, i)) return { kind: 'found', token, index: i };
    }

    const ch = text[i];

    // Single-quoted literal. A quote is escaped by doubling (`''`) and, in an E-prefixed escape
    // string, ALSO by a backslash. Measured on PostgreSQL 17: `SELECT E'foo\'--bar'` is the single
    // string `foo'--bar`. Without the backslash rule the scan closed the literal at that inner
    // quote, saw the following `--` at top level, and refused a legal fragment.
    //
    // Only for E-strings, because `standard_conforming_strings` is `on` (the default since 9.1, and
    // verified on the same server), so in a plain literal a backslash is an ordinary character and
    // `'a\'` really does end there.
    //
    // That is an ASSUMPTION, not something this library checks — there is no runtime `SHOW` guard,
    // and adding one would make a pure function need a connection. It is safe to assume because
    // being wrong about it fails in the harmless direction: with the setting `off`, a plain literal
    // WOULD honour backslash escapes, so the scan closes it earlier than the server does, ends up at
    // top level sooner, and finds MORE tokens. That refuses valid input; it never passes a separator
    // the server would execute. Every divergence in this lexer is held to that direction.
    if (ch === "'") {
      const escapeString = isEscapeStringPrefix(text, i);
      i++;
      let closed = false;
      while (i < text.length) {
        if (escapeString && text[i] === '\\') {
          i += 2; // the backslash and whatever it escapes, quote included
          continue;
        }
        if (text[i] === "'") {
          if (text[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          closed = true;
          break;
        }
        i++;
      }
      if (!closed) return { kind: 'unterminated' };
      continue;
    }

    // Double-quoted IDENTIFIER, its own state, `""` escaping an embedded quote. Omitting this
    // desynchronised the scanner on a legal identifier containing a single quote: in
    // `SELECT "a'b" FROM t; DROP TABLE victim; SELECT "c'd" FROM u` it entered "string literal" at
    // the quote inside "a'b", stayed there past both real separators, and left at the one inside
    // "c'd" — so the text scanned clean and the DROP TABLE was emitted verbatim. Reachable, because
    // `pull` feeds `pg_get_viewdef` output straight back in.
    if (ch === '"') {
      i++;
      let closed = false;
      while (i < text.length) {
        if (text[i] === '"') {
          if (text[i + 1] === '"') {
            i += 2;
            continue;
          }
          i++;
          closed = true;
          break;
        }
        i++;
      }
      if (!closed) return { kind: 'unterminated' };
      continue;
    }

    // Line comment. Ends at a CARRIAGE RETURN as well as a line feed: measured on 17,
    // `SELECT 'first' -- comment\r; SELECT 'SECOND_RAN'` runs BOTH statements, so a bare CR
    // terminates the comment and the `;` after it is a real separator. Searching only for `\n`
    // treated the rest of the input as commented out and hid that separator — the same bypass
    // shape as the dollar-tag case, one lexer state over. (CRLF was always fine; it contains a
    // `\n`. It is the classic-Mac lone CR that was not.)
    //
    // Running to end-of-input is clean, not unterminated — see {@link LexResult}.
    if (ch === '-' && text[i + 1] === '-') {
      const nl = indexOfLineEnd(text, i);
      if (nl === -1) return { kind: 'clean' };
      i = nl + 1;
      continue;
    }

    // Block comment. PostgreSQL NESTS these, unlike C — measured on 17:
    // `SELECT /* a /* b */ still_comment */ 42` returns 42, and
    // `SELECT 1 /* a /* b */ ; */ + 1` returns 2, so the `;` inside is inert.
    //
    // Stopping at the first `*/` therefore left the scan at top level while the server was still
    // inside the comment, which reported an inert `;` as a real separator and refused a legal view
    // body. Depth-tracked instead.
    if (ch === '/' && text[i + 1] === '*') {
      let depth = 1;
      i += 2;
      while (i < text.length && depth > 0) {
        if (text[i] === '/' && text[i + 1] === '*') {
          depth++;
          i += 2;
          continue;
        }
        if (text[i] === '*' && text[i + 1] === '/') {
          depth--;
          i += 2;
          continue;
        }
        i++;
      }
      if (depth > 0) return { kind: 'unterminated' };
      continue;
    }

    // A dollar-quote tag OPENS a quoted block only when the `$` does not continue an identifier.
    // `$` is legal inside a PostgreSQL identifier (just not first), so in `x$t$ ; $t$` the server
    // lexes `x$t$` as the identifier `x$t$` — measured on 17, which reports "unterminated
    // dollar-quoted string" against the SECOND `$t$`, proving the `;` between them was read as a
    // real separator. Without this check the scan treated `$t$ … $t$` as a quoted block and called
    // that input clean, staying "inside a quote" while the server was at top level. That is the
    // dangerous direction: it would pass a statement separator, and a DROP after it, as inert.
    //
    // Third instance of this same family, after the digit-leading tag and the quoted-identifier
    // desync — every one of them a state the scan entered when PostgreSQL did not.
    if (ch === '$' && !isIdentifierChar(text[i - 1])) {
      // The tag itself follows UNQUOTED-IDENTIFIER rules, so it cannot begin with a digit: `$$` and
      // `$tag$` are the only legal forms. Allowing a leading digit treated `$1$ … $1$` as a quoted
      // block and skipped a separator inside it that PostgreSQL reads as real.
      const tag = /^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/.exec(text.slice(i))?.[0];
      if (tag !== undefined) {
        const end = text.indexOf(tag, i + tag.length);
        if (end === -1) return { kind: 'unterminated' };
        i = end + tag.length;
        continue;
      }
    }

    i++;
  }
  return { kind: 'clean' };
}
