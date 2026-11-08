#!/usr/bin/env node
/**
 * Build the client locale dictionaries from locale/messages.csv.
 *
 * The CSV is the single source of truth: one row per UI key, one column per
 * locale. This script validates the table and writes the generated block into
 * lib/client.js; the browser bundle stays a single hand-written file.
 *
 * Usage:
 *   node scripts/build-locales.mjs           # rewrite lib/client.js
 *   node scripts/build-locales.mjs --check   # verify without writing
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const BUILTIN_LOCALES = ['zh', 'en', 'ja', 'es', 'fr', 'de', 'ru', 'pt'];
export const BEGIN_MARKER = '// BEGIN GENERATED LOCALES';
export const END_MARKER = '// END GENERATED LOCALES';

const LOCALE_ID = /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/;
const KEY_ID = /^[A-Za-z][A-Za-z0-9_.-]*$/;
const FORBIDDEN = /[\u200B\uFEFF]/u;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CSV_PATH = path.join(ROOT, 'locale', 'messages.csv');
const CLIENT_PATH = path.join(ROOT, 'lib', 'client.js');

/**
 * Parse RFC 4180 CSV into rows with their one-based source line.
 * @param {string} text raw CSV text.
 * @returns {{ line: number, cells: string[] }[]}
 */
export function parseCsv(text) {
  const rows = [];
  let cells = [];
  let field = '';
  let quoted = false;
  let line = 1;
  let rowLine = 1;
  let fieldLine = 1;

  const pushRow = () => {
    cells.push(field);
    rows.push({ line: rowLine, cells });
    cells = [];
    field = '';
    rowLine = line;
    fieldLine = line;
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        if (char === '\n') line += 1;
        field += char;
      }
      continue;
    }
    if (char === '"') {
      if (field !== '') throw new Error(`line ${line}: unexpected quote inside an unquoted field`);
      quoted = true;
      fieldLine = line;
      continue;
    }
    if (char === ',') {
      cells.push(field);
      field = '';
      continue;
    }
    if (char === '\n') {
      pushRow();
      line += 1;
      continue;
    }
    if (char === '\r') continue;
    field += char;
  }

  if (quoted) throw new Error(`line ${fieldLine}: unterminated quoted field`);
  if (field !== '' || cells.length !== 0) pushRow();

  while (rows.length && rows[rows.length - 1].cells.every((cell) => cell.trim() === '')) rows.pop();
  return rows;
}

/**
 * Parse the messages table into locale dictionaries.
 * @param {string} text raw CSV text.
 * @returns {{ locales: string[], keys: string[], messages: Record<string, Record<string, string>> }}
 */
export function parseMessages(text) {
  const rows = parseCsv(text.replace(/^\uFEFF/, ''));
  if (rows.length === 0) throw new Error('locale/messages.csv is empty');

  const header = rows[0].cells.map((cell) => cell.trim());
  if (header[0] !== 'key') throw new Error('line 1: the first column must be "key"');
  const locales = header.slice(1);
  if (locales.length === 0) throw new Error('line 1: no language columns');
  const keys = [];
  const messages = Object.fromEntries(locales.map((locale) => [locale, Object.create(null)]));

  for (const row of rows.slice(1)) {
    if (row.cells.every((cell) => cell.trim() === '')) continue;
    if (row.cells.length !== header.length) {
      throw new Error(`line ${row.line}: expected ${header.length} columns, got ${row.cells.length}`);
    }
    const [key, ...values] = row.cells.map((cell) => cell.trim());
    keys.push(key);
    locales.forEach((locale, index) => {
      messages[locale][key] = values[index];
    });
  }

  return { locales, keys, messages };
}

/** Return the {placeholder} names used by a template, sorted for comparison. */
function placeholdersOf(text) {
  return [...String(text).matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort().join(',');
}

/**
 * Throw on structural, bilingual-pair, or placeholder problems.
 * @param {{ locales: string[], keys: string[], messages: Record<string, Record<string, string>> }} parsed
 */
export function validateMessages(parsed) {
  const { locales, keys, messages } = parsed;
  if (locales.length !== BUILTIN_LOCALES.length || locales.some((locale, index) => locale !== BUILTIN_LOCALES[index])) {
    throw new Error(`locale columns must be exactly ${BUILTIN_LOCALES.join(', ')}; got ${locales.join(', ')}`);
  }
  for (const locale of locales) {
    if (!LOCALE_ID.test(locale)) throw new Error(`"${locale}" is not a lowercase BCP 47-style locale id`);
  }
  if (keys.length === 0) throw new Error('locale/messages.csv has no message rows');

  const seen = new Set();
  for (const key of keys) {
    if (!KEY_ID.test(key)) throw new Error(`invalid message key "${key}"`);
    if (seen.has(key)) throw new Error(`duplicate message key "${key}"`);
    seen.add(key);
  }

  for (const key of keys) {
    const expected = placeholdersOf(messages.zh[key]);
    for (const locale of locales) {
      const value = messages[locale][key];
      if (typeof value !== 'string' || value === '') throw new Error(`${locale}:${key} must not be empty`);
      if (FORBIDDEN.test(value)) throw new Error(`${locale}:${key} contains a zero-width space or BOM`);
      if (/[\r\n]/.test(value)) throw new Error(`${locale}:${key} must stay on one line`);
      if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value)) throw new Error(`${locale}:${key} contains a control character`);
      if (placeholdersOf(value) !== expected) {
        throw new Error(`${locale}:${key} placeholders differ from zh (expected {${expected}})`);
      }
    }
  }
}

/**
 * Render the generated block, including its markers.
 * @param {{ locales: string[], keys: string[], messages: Record<string, Record<string, string>> }} parsed
 * @returns {string}
 */
export function renderLocaleBlock(parsed) {
  const lines = [
    `    ${BEGIN_MARKER} — source: locale/messages.csv; regenerate with \`npm run build:locales\`.`,
    '    const MESSAGES = {'
  ];
  for (const locale of parsed.locales) {
    lines.push(`      ${JSON.stringify(locale)}: {`);
    for (const key of parsed.keys) {
      lines.push(`        ${JSON.stringify(key)}: ${JSON.stringify(parsed.messages[locale][key])},`);
    }
    lines.push('      },');
  }
  lines.push('    };', `    ${END_MARKER}`);
  return `${lines.join('\n')}\n`;
}

/** Extract the existing generated block (without its leading indentation). */
function extractLocaleBlock(source) {
  const start = source.indexOf(BEGIN_MARKER);
  if (start < 0) return '';
  const lineStart = source.lastIndexOf('\n', start) + 1;
  const end = source.indexOf(END_MARKER, start);
  if (end < 0) return '';
  const endLine = source.indexOf('\n', end);
  return source.slice(lineStart, endLine < 0 ? source.length : endLine + 1);
}

/**
 * Compare lib/client.js's generated block with the CSV.
 * @param {string} source client bundle text.
 * @param {{ locales: string[], keys: string[], messages: Record<string, Record<string, string>> }} parsed
 * @returns {{ ok: boolean, message: string }}
 */
export function checkLocaleBlock(source, parsed) {
  const actual = extractLocaleBlock(source);
  if (!actual) return { ok: false, message: 'lib/client.js has no generated locale block; run npm run build:locales' };
  const expected = renderLocaleBlock(parsed);
  if (actual !== expected) return { ok: false, message: 'lib/client.js locale block is out of date; run npm run build:locales' };
  return { ok: true, message: '' };
}

/**
 * Replace the generated block in lib/client.js.
 * @param {string} source client bundle text.
 * @param {string} block rendered block.
 * @returns {string}
 */
export function replaceLocaleBlock(source, block) {
  const start = source.indexOf(BEGIN_MARKER);
  if (start < 0) throw new Error('lib/client.js is missing the BEGIN GENERATED LOCALES marker');
  const lineStart = source.lastIndexOf('\n', start) + 1;
  const end = source.indexOf(END_MARKER, start);
  if (end < 0) throw new Error('lib/client.js is missing the END GENERATED LOCALES marker');
  const endLine = source.indexOf('\n', end);
  return source.slice(0, lineStart) + block + source.slice(endLine < 0 ? source.length : endLine + 1);
}

/**
 * Collect every literal `t('key')` in the client, outside the generated block.
 * @param {string} source client bundle text.
 * @returns {string[]}
 */
export function collectTranslationKeys(source) {
  const start = source.indexOf(BEGIN_MARKER);
  const end = source.indexOf(END_MARKER);
  const body = start >= 0 && end > start
    ? source.slice(0, start) + source.slice(source.indexOf('\n', end))
    : source;
  const keys = new Set();
  for (const match of body.matchAll(/\bt\(\s*(['"])((?:\\.|(?!\1)[^\\])*?)\1/g)) keys.add(match[2]);
  return [...keys];
}

function main() {
  const checkOnly = process.argv.includes('--check');
  const parsed = parseMessages(readFileSync(CSV_PATH, 'utf8'));
  validateMessages(parsed);
  const source = readFileSync(CLIENT_PATH, 'utf8');

  if (checkOnly) {
    const result = checkLocaleBlock(source, parsed);
    if (!result.ok) {
      console.error(result.message);
      process.exitCode = 1;
      return;
    }
    console.log(`locale block is up to date (${parsed.keys.length} keys × ${parsed.locales.length} locales)`);
    return;
  }

  const next = replaceLocaleBlock(source, renderLocaleBlock(parsed));
  if (next === source) {
    console.log(`locale block already up to date (${parsed.keys.length} keys × ${parsed.locales.length} locales)`);
    return;
  }
  writeFileSync(CLIENT_PATH, next);
  console.log(`wrote ${parsed.keys.length} keys × ${parsed.locales.length} locales to lib/client.js`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main();
