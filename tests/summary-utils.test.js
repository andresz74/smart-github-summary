import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildMarkdownSummary,
  DEFAULT_MODEL,
  extractSummaryPayload,
  extractTranscriptMetadata,
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

test('extractTranscriptMetadata parses repo description and languages', () => {
  const transcript = [
    'Repository: octocat/Hello-World',
    'Description: Example repository',
    '',
    'Languages:',
    '{',
    '  "JavaScript": 100,',
    '  "HTML": 50',
    '}',
    '',
    'README:',
    'Example readme',
  ].join('\n');

  assert.deepEqual(extractTranscriptMetadata(transcript), {
    repo: 'octocat/Hello-World',
    description: 'Example repository',
    languages: ['JavaScript', 'HTML'],
  });
});

test('buildMarkdownSummary wraps summary in frontmatter and markdown sections', () => {
  const markdown = buildMarkdownSummary({
    normalized: {
      repo: 'octocat/Hello-World',
      type: 'digest',
      sourceId: 'abc123',
      metadata: { repoUrl: 'https://github.com/octocat/Hello-World' },
    },
    metadata: {
      repo: 'octocat/Hello-World',
      description: 'Example repository',
      languages: ['JavaScript', 'HTML'],
    },
    summary: 'A concise repository summary.',
    keyPoints: ['Point one'],
    actionItems: ['Do something'],
  });

  assert.match(markdown, /^# octocat\/Hello-World/);
  assert.match(markdown, /Repository: https:\/\/github.com\/octocat\/Hello-World/);
  assert.match(markdown, /Tags: github, repository, octocat, javascript, html/);
  assert.match(markdown, /## Key Points/);
  assert.match(markdown, /## Action Items/);
});
