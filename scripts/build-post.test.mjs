/**
 * Tests for the post reflow.
 *
 * GitHub renders a single newline as a <br> in Discussions, so the spec's
 * 80-column wrapping has to be undone on the way out. A silent bug here
 * corrupts the published document rather than failing loudly, which is the
 * whole reason these exist.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { reflow } from './build-post.mjs';

describe('reflow', () => {
  test('folds a hard-wrapped paragraph onto one line', () => {
    assert.equal(reflow('one two\nthree four\nfive'), 'one two three four five');
  });

  test('keeps paragraphs separated by a blank line apart', () => {
    assert.equal(reflow('first\npara\n\nsecond\npara'), 'first para\n\nsecond para');
  });

  test('leaves fenced code exactly as written', () => {
    const fenced = '```\nreal-estate  treasury\npublic-equity  fund\n```';

    assert.equal(reflow(fenced), fenced);
  });

  test('does not fold prose that merely follows a fence', () => {
    const input = '```\ncode line\n```\nprose one\nprose two';

    assert.equal(reflow(input), '```\ncode line\n```\nprose one prose two');
  });

  test('leaves table rows on their own lines', () => {
    const table = '| a | b |\n|---|---|\n| 1 | 2 |';

    assert.equal(reflow(table), table);
  });

  test('keeps headings on their own line and does not swallow the next line', () => {
    assert.equal(reflow('## Heading\nbody text\nmore body'), '## Heading\nbody text more body');
  });

  test('folds list continuations into their item, keeping the marker', () => {
    const input = '1. first item\n   continues here\n2. second item';

    assert.equal(reflow(input), '1. first item continues here\n2. second item');
  });

  test('keeps sibling bullets separate', () => {
    const input = '- **Status:** Draft\n- **Author:** someone';

    assert.equal(reflow(input), input);
  });

  test('treats a horizontal rule as a rule, not a bullet', () => {
    // `---` matches both patterns; rules are tested first for this reason.
    assert.equal(reflow('para\n\n---\n\nnext'), 'para\n\n---\n\nnext');
  });

  test('preserves a table immediately after a paragraph', () => {
    const input = 'lead in\ntext\n| a | b |\n|---|---|';

    assert.equal(reflow(input), 'lead in text\n| a | b |\n|---|---|');
  });

  test('is lossless — only whitespace changes', () => {
    const input = [
      '# Title', '', 'A wrapped', 'paragraph here.', '',
      '- bullet one', '  continued', '- bullet two', '',
      '```', 'literal  spacing   kept', '```', '',
      '| x | y |', '|---|---|', '', 'Trailing prose', 'wrapped too.',
    ].join('\n');

    assert.deepEqual(reflow(input).split(/\s+/), input.split(/\s+/));
  });
});
