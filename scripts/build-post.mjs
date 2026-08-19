/**
 * Assembles the GitHub Discussion post body: the lead from
 * docs/discussion-intro.md, then SPEC.md without its H1 (the Discussion title
 * carries that). Writes post.md, which is gitignored — the spec is never
 * duplicated in this repository.
 *
 * The spec is hard-wrapped at 80 columns, which is right for a file in git and
 * wrong for a GitHub comment: GitHub Flavored Markdown renders a single newline
 * as a <br> in Discussions, issues, and PRs, so every wrapped line becomes a
 * visible break mid-sentence. So paragraphs are reflowed onto single lines on
 * the way out. Anything line-structured — fences, tables, headings, rules — is
 * passed through untouched, and list items keep their marker while their
 * continuation lines fold into them.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^#{1,6}\s/;
const TABLE_ROW = /^\s*\|/;
const RULE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+/;

/** Reflow hard-wrapped paragraphs onto single lines, preserving structure. */
export function reflow(markdown) {
  const out = [];
  let buffer = [];
  let inFence = false;

  const flush = () => {
    if (buffer.length === 0) return;
    // First line keeps its indent and any list marker; the rest fold in.
    const [first, ...rest] = buffer;
    out.push([first.trimEnd(), ...rest.map((line) => line.trim())].join(' '));
    buffer = [];
  };

  for (const line of markdown.split('\n')) {
    if (FENCE.test(line)) {
      flush();
      out.push(line);
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }

    if (line.trim() === '') {
      flush();
      out.push('');
      continue;
    }
    // Rules must be tested before list items: "---" also matches a bullet.
    if (RULE.test(line) || HEADING.test(line) || TABLE_ROW.test(line)) {
      flush();
      out.push(line);
      continue;
    }
    if (LIST_ITEM.test(line)) {
      flush();
      buffer.push(line);
      continue;
    }
    buffer.push(line);
  }
  flush();

  return out.join('\n');
}

/** Guarded so the tests can import `reflow` without writing post.md. */
function main() {
  const intro = readFileSync('docs/discussion-intro.md', 'utf8');
  const lead = intro.slice(intro.indexOf('Posting this as a draft'));
  const spec = readFileSync('SPEC.md', 'utf8');
  const body = lead + spec.split('\n').slice(1).join('\n').replace(/^\n+/, '');

  writeFileSync('post.md', reflow(body));
  console.log('post.md written — paste into the Discussion body');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
