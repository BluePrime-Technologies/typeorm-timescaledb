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
export function findUnquotedToken(text: string, tokens: readonly string[]): LexResult {
  let i = 0;
  while (i < text.length) {
    // Caller's tokens win over the skip states — see the note above.
    for (const token of tokens) {
      if (text.startsWith(token, i)) return { kind: 'found', token, index: i };
    }

    const ch = text[i];

    // Single-quoted literal, `''` escaping an embedded quote.
    if (ch === "'") {
      i++;
      let closed = false;
      while (i < text.length) {
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

    // Line comment. Running to end-of-input is clean, not unterminated — see {@link LexResult}.
    if (ch === '-' && text[i + 1] === '-') {
      const nl = text.indexOf('\n', i);
      if (nl === -1) return { kind: 'clean' };
      i = nl + 1;
      continue;
    }

    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) return { kind: 'unterminated' };
      i = end + 2;
      continue;
    }

    if (ch === '$') {
      // A dollar-quote tag follows UNQUOTED-IDENTIFIER rules, so it cannot begin with a digit —
      // `$$` and `$tag$` are the only legal forms. Allowing a leading digit treated `$1$ … $1$` as
      // a quoted block and skipped a statement separator inside it that PostgreSQL would have read
      // as real, so the scanner skipped text the server executes.
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
