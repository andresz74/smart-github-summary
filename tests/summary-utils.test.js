import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_MODEL,
  extractSummaryPayload,
  normalizeRequestBody,
  parseRepoFromUrl,
} from '../src/summary-utils.js';

test('parseRepoFromUrl extracts owner/repo safely', () => {
  assert.equal(parseRepoFromUrl('https://github.com/octocat/Hello-World'), 'octocat/Hello-World');
  assert.equal(parseRepoFromUrl('https://github.com/octocat'), null);
  assert.equal(parseRepoFromUrl('invalid-url'), null);
});

test('normalizeRequestBody accepts extension payload and normalizes model aliases', () => {
  const result = normalizeRequestBody({
    repoUrl: 'https://github.com/octocat/Hello-World',
    transcript: 'repo context',
    model: 'chatgpt',
  });

  assert.equal(result.repo, 'octocat/Hello-World');
  assert.equal(result.type, 'digest');
  assert.equal(result.content, 'repo context');
  assert.equal(result.model, DEFAULT_MODEL);
  assert.equal(result.title, 'Repository Summary: octocat/Hello-World');
  assert.match(result.sourceId, /^[a-f0-9]{12}$/);
});

test('normalizeRequestBody preserves structured payload fields', () => {
  const result = normalizeRequestBody({
    repo: 'owner/repo',
    type: 'release',
    sourceId: 'abc123',
    title: 'Custom Title',
    content: 'content',
    model: 'openai-chat-axios',
    metadata: { source: 'test' },
  });

  assert.equal(result.repo, 'owner/repo');
  assert.equal(result.type, 'release');
  assert.equal(result.sourceId, 'abc123');
  assert.equal(result.title, 'Custom Title');
  assert.equal(result.content, 'content');
  assert.equal(result.model, DEFAULT_MODEL);
  assert.deepEqual(result.metadata, { source: 'test' });
});

test('extractSummaryPayload handles JSON and plain text responses', () => {
  assert.deepEqual(
    extractSummaryPayload('{"summary":"Hello","keyPoints":["A"],"actionItems":["B"]}'),
    {
      summary: 'Hello',
      keyPoints: ['A'],
      actionItems: ['B'],
    },
  );

  assert.deepEqual(extractSummaryPayload('Plain text summary'), {
    summary: 'Plain text summary',
    keyPoints: [],
    actionItems: [],
  });
});
