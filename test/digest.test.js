// Genie rebuild step 8.7: every digest bullet opens with a lane tag, and an untagged bullet is found.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { untaggedBullets, LANE_TAGS } = await import('../src/digest.js');

test('tagged bullets pass, untagged ones are named', () => {
  const body = [
    '## What moved outside',
    '- [MODELS] [CAPITAL] Nvidia CEO resigned: [x](https://a)',
    '- Anthropic prices its IPO: [y](https://b)',
    '## Signals for North Star',
    'No priority signal today.',
    '1. [VFARM] A grow-light study: [z](https://c)',
    '* [ROBOTS] wrong tag',
  ].join('\n');
  assert.deepEqual(untaggedBullets(body), ['Anthropic prices its IPO: [y](https://b)', '[ROBOTS] wrong tag']);
});

test('the vocabulary holds Jason\'s four tags', () => {
  for (const t of ['CAPITAL', 'VFARM', 'PHYSICAL_AI', 'MODELS']) assert.ok(LANE_TAGS.includes(t));
});
