/**
 * Assembles the GitHub Discussion post body: the lead from
 * docs/discussion-intro.md, then SPEC.md without its H1 (the Discussion title
 * carries that). Writes post.md, which is gitignored — the spec is never
 * duplicated in the repository.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const intro = readFileSync('docs/discussion-intro.md', 'utf8');
const lead = intro.slice(intro.indexOf('Posting this as a draft'));
const spec = readFileSync('SPEC.md', 'utf8');

writeFileSync('post.md', lead + spec.split('\n').slice(1).join('\n').replace(/^\n+/, ''));
console.log('post.md written — paste into the Discussion body');
