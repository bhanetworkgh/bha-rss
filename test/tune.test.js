// Genie rebuild step 8.8: the counts BHA RSS sends for scoring are counted from what the digests really link.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { citedLinks, candidates, host } = await import('../src/tune.js');

test('each bullet link is counted once per bullet, headings and prose are not', () => {
  const body = [
    '## What moved outside',
    'Intro with [a link](https://news.example/one) that is not a bullet.',
    '- [CAPITAL] Something: [One](https://news.example/one) and again [One](https://news.example/one)',
    '- [VFARM] Other: [Two](https://farm.example/two?utm=x&y=1)',
    '## Signals for North Star',
    '1. [AGENTS] Same item cited again: [One](https://news.example/one)',
  ].join('\n');
  assert.deepEqual(citedLinks(body), ['https://news.example/one', 'https://farm.example/two?utm=x&y=1', 'https://news.example/one']);
});

test('a site is proposed only when three cited items link it and it is not a source or a platform', () => {
  const it = (url, content) => ({ url, content });
  const items = [
    it('https://a.example/1', 'see https://www.newsite.org/x and https://youtube.com/watch?v=1'),
    it('https://a.example/2', 'per https://newsite.org/y, also https://known.example/z'),
    it('https://b.example/3', '(https://newsite.org/z) and https://twosite.org/q'),
    it('https://b.example/4', 'https://twosite.org/r'),
  ];
  const out = candidates(items, new Set(['known.example']));
  assert.deepEqual(out.map((c) => c.host), ['newsite.org']);
  assert.equal(out[0].evidence.length, 3);
  assert.equal(host('https://www.Example.com/a'), 'example.com');
});
