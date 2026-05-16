import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { TokenizeError, tokenize, type Token } from '../../../src/sql/tokenize.ts';

function values(input: string): string[] {
  return tokenize(input).map((t) => t.value);
}

function nonWhitespace(input: string): Token[] {
  return [...tokenize(input)].filter((t) => t.kind !== 'whitespace');
}

// ---------------------------------------------------------------------------
// Whitespace, comments
// ---------------------------------------------------------------------------

test('tokenize: whitespace collapsed into a single token', () => {
  const out = tokenize('   \t\n  ');
  assert.equal(out.length, 1);
  assert.equal(out[0]?.kind, 'whitespace');
  assert.equal(out[0]?.value, '   \t\n  ');
});

test('tokenize: empty input gives no tokens', () => {
  assert.deepEqual(tokenize(''), []);
});

test('tokenize: line comment runs to newline only', () => {
  const out = tokenize('-- a comment\nSELECT');
  assert.deepEqual(
    out.map((t) => t.kind),
    ['line-comment', 'whitespace', 'identifier'],
  );
  assert.equal(out[0]?.value, '-- a comment');
});

test('tokenize: line comment containing a quote does not open a string', () => {
  const out = nonWhitespace("-- it's fine\n42");
  assert.equal(out[0]?.kind, 'line-comment');
  assert.equal(out[1]?.kind, 'number');
  assert.equal(out[1]?.value, '42');
});

test('tokenize: block comment spans newlines', () => {
  const out = tokenize('/* line1\nline2 */end');
  assert.deepEqual(
    out.map((t) => t.kind),
    ['block-comment', 'identifier'],
  );
  assert.equal(out[0]?.value, '/* line1\nline2 */');
});

test('tokenize: block comment containing a quote does not open a string', () => {
  const out = nonWhitespace("/* it's also fine */ SELECT");
  assert.equal(out[0]?.kind, 'block-comment');
  assert.equal(out[1]?.kind, 'identifier');
});

test('tokenize: unterminated block comment throws TokenizeError', () => {
  assert.throws(
    () => tokenize('/* not closed'),
    (err: unknown) => err instanceof TokenizeError,
  );
});

// ---------------------------------------------------------------------------
// Strings
// ---------------------------------------------------------------------------

test('tokenize: single-quoted string', () => {
  const out = nonWhitespace("'hello world'");
  assert.equal(out[0]?.kind, 'string');
  assert.equal(out[0]?.value, "'hello world'");
});

test('tokenize: double-quoted string', () => {
  const out = nonWhitespace('"hello world"');
  assert.equal(out[0]?.kind, 'string');
  assert.equal(out[0]?.value, '"hello world"');
});

test('tokenize: string containing -- is not split into a comment', () => {
  const out = nonWhitespace("'-- not a comment'");
  assert.equal(out.length, 1);
  assert.equal(out[0]?.kind, 'string');
  assert.equal(out[0]?.value, "'-- not a comment'");
});

test('tokenize: string with escaped quote', () => {
  const out = nonWhitespace("'it\\'s fine'");
  assert.equal(out[0]?.kind, 'string');
  assert.equal(out[0]?.value, "'it\\'s fine'");
});

test('tokenize: string with escaped backslash', () => {
  const out = nonWhitespace("'foo\\\\bar'");
  assert.equal(out[0]?.kind, 'string');
  assert.equal(out[0]?.value, "'foo\\\\bar'");
});

test('tokenize: raw string prefix r"..." preserves backslashes literally', () => {
  const out = nonWhitespace("r'a\\nb'");
  assert.equal(out[0]?.kind, 'raw-string');
  assert.equal(out[0]?.value, "r'a\\nb'");
});

test('tokenize: bytes literal b"..."', () => {
  const out = nonWhitespace("b'hello'");
  assert.equal(out[0]?.kind, 'bytes');
});

test('tokenize: raw bytes literal rb"..." and br"..."', () => {
  const out1 = nonWhitespace("rb'foo'");
  assert.equal(out1[0]?.kind, 'raw-bytes');
  const out2 = nonWhitespace('br"foo"');
  assert.equal(out2[0]?.kind, 'raw-bytes');
});

test('tokenize: string-prefix letters at start of identifier are NOT prefixes', () => {
  // "rate" should tokenize as an identifier, not as r'ate'.
  const out = nonWhitespace('rate');
  assert.equal(out[0]?.kind, 'identifier');
  assert.equal(out[0]?.value, 'rate');
});

test('tokenize: unterminated string throws TokenizeError', () => {
  assert.throws(
    () => tokenize("'unterminated"),
    (err: unknown) => err instanceof TokenizeError,
  );
});

test('tokenize: newline inside string throws TokenizeError', () => {
  assert.throws(
    () => tokenize("'line1\nline2'"),
    (err: unknown) => err instanceof TokenizeError,
  );
});

// ---------------------------------------------------------------------------
// Backtick identifiers
// ---------------------------------------------------------------------------

test('tokenize: backtick identifier preserves dots', () => {
  const out = nonWhitespace('`project.dataset.table`');
  assert.equal(out[0]?.kind, 'backtick-identifier');
  assert.equal(out[0]?.value, '`project.dataset.table`');
});

test('tokenize: unterminated backtick throws', () => {
  assert.throws(
    () => tokenize('`unclosed'),
    (err: unknown) => err instanceof TokenizeError,
  );
});

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

test('tokenize: integer', () => {
  assert.deepEqual(values('42'), ['42']);
  assert.equal(tokenize('42')[0]?.kind, 'number');
});

test('tokenize: decimal', () => {
  assert.deepEqual(values('3.14'), ['3.14']);
});

test('tokenize: decimal starting with dot', () => {
  assert.deepEqual(values('.5'), ['.5']);
  assert.equal(tokenize('.5')[0]?.kind, 'number');
});

test('tokenize: scientific notation with explicit sign', () => {
  assert.equal(tokenize('1.5e-3')[0]?.value, '1.5e-3');
  assert.equal(tokenize('2E+10')[0]?.value, '2E+10');
});

test('tokenize: number followed by punctuation', () => {
  const out = nonWhitespace('42,3');
  assert.deepEqual(
    out.map((t) => [t.kind, t.value] as const),
    [
      ['number', '42'],
      ['punctuation', ','],
      ['number', '3'],
    ],
  );
});

test('tokenize: bare dot (not a number) is punctuation', () => {
  const out = nonWhitespace('a.b');
  assert.deepEqual(
    out.map((t) => t.kind),
    ['identifier', 'punctuation', 'identifier'],
  );
});

test('tokenize: malformed exponent throws', () => {
  assert.throws(
    () => tokenize('1e'),
    (err: unknown) => err instanceof TokenizeError,
  );
});

// ---------------------------------------------------------------------------
// Identifiers and parameters
// ---------------------------------------------------------------------------

test('tokenize: identifier with underscores and digits', () => {
  const out = nonWhitespace('_foo_BAR_123');
  assert.equal(out[0]?.kind, 'identifier');
  assert.equal(out[0]?.value, '_foo_BAR_123');
});

test('tokenize: parameter @name', () => {
  const out = nonWhitespace('@since');
  assert.equal(out[0]?.kind, 'parameter');
  assert.equal(out[0]?.value, '@since');
});

test('tokenize: parameter @0_name', () => {
  const out = nonWhitespace('@_param2');
  assert.equal(out[0]?.kind, 'parameter');
  assert.equal(out[0]?.value, '@_param2');
});

test('tokenize: bare @ with no name throws', () => {
  assert.throws(
    () => tokenize('@'),
    (err: unknown) => err instanceof TokenizeError,
  );
});

// ---------------------------------------------------------------------------
// Operators / punctuation
// ---------------------------------------------------------------------------

test('tokenize: multi-char operators', () => {
  for (const op of ['!=', '<>', '<=', '>=', '==', '||', '&&', '::']) {
    const out = nonWhitespace(`a ${op} b`);
    assert.deepEqual(
      out.map((t) => t.kind),
      ['identifier', 'operator', 'identifier'],
    );
    assert.equal(out[1]?.value, op);
  }
});

test('tokenize: single-char operators', () => {
  for (const op of ['+', '-', '*', '/', '%', '=', '<', '>', '!']) {
    const out = nonWhitespace(`a ${op} b`);
    assert.equal(out[1]?.kind, 'operator');
    assert.equal(out[1]?.value, op);
  }
});

test('tokenize: punctuation', () => {
  for (const p of ['(', ')', ',', ';', '.', '[', ']', '{', '}']) {
    const out = nonWhitespace(p);
    assert.equal(out[0]?.kind, 'punctuation');
    assert.equal(out[0]?.value, p);
  }
});

test('tokenize: unknown character throws', () => {
  assert.throws(
    () => tokenize('§'),
    (err: unknown) => err instanceof TokenizeError,
  );
});

// ---------------------------------------------------------------------------
// Token offsets
// ---------------------------------------------------------------------------

test('tokenize: token start/end offsets cover the full input', () => {
  const input = "SELECT a FROM `ds.t` WHERE a = 'x' AND b > 0";
  const out = tokenize(input);
  // start of token 0 is 0, end of last token equals input.length, and tokens
  // are contiguous.
  assert.equal(out[0]?.start, 0);
  assert.equal(out[out.length - 1]?.end, input.length);
  for (let i = 1; i < out.length; i++) {
    assert.equal(out[i - 1]?.end, out[i]?.start, `gap before token ${i}`);
  }
});

test('tokenize: slicing by start/end recovers each token', () => {
  const input = "SELECT 42, 'hi', `bt`";
  const out = tokenize(input);
  for (const t of out) {
    assert.equal(input.slice(t.start, t.end), t.value);
  }
});

// ---------------------------------------------------------------------------
// Realistic snippet — close to what the drops queries look like
// ---------------------------------------------------------------------------

test('tokenize: a realistic v0 BQ query lexes cleanly', () => {
  const sql = `
    SELECT MAX(created_at)
    FROM \`dataset.events\` e
    WHERE e.type = 'drops.dropInteraction'
      AND JSON_VALUE(e.payload, '$.licenses."us-east"') IS NOT NULL
      AND e.created_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY)
      AND e.id IN UNNEST(@ids)
    ORDER BY e.created_at ASC
  `;
  const tokens = tokenize(sql);
  // Spot-check that the @-parameter and backtick survived as their own tokens.
  const parameters = tokens.filter((t) => t.kind === 'parameter');
  assert.equal(parameters.length, 1);
  assert.equal(parameters[0]?.value, '@ids');
  const backticks = tokens.filter((t) => t.kind === 'backtick-identifier');
  assert.equal(backticks.length, 1);
  assert.equal(backticks[0]?.value, '`dataset.events`');
  // And the strings are preserved verbatim with their quotes.
  const strings = tokens.filter((t) => t.kind === 'string');
  assert.equal(strings.length, 2);
  assert.equal(strings[0]?.value, "'drops.dropInteraction'");
  assert.match(strings[1]?.value ?? '', /licenses/);
  // Confirm at least 1 line comment isn't introduced from the "--" inside any
  // string.
  assert.equal(tokens.filter((t) => t.kind === 'line-comment').length, 0);
});
