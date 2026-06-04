// Unit tests for Codex Assistant core modules
// Uses Node.js native test runner (node:test) — zero dependencies
// Run with: node --test tests/

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

// ---- Test normalizeMessages (protocol module) ----
import { normalizeMessages } from '../src/protocol.mjs';

describe('normalizeMessages', () => {
  it('should return empty array for empty input', () => {
    assert.deepEqual(normalizeMessages([]), []);
  });

  it('should pass through simple user-assistant exchange', () => {
    const msgs = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
    ];
    const result = normalizeMessages(msgs);
    assert.equal(result.length, 2);
    assert.equal(result[0].role, 'user');
    assert.equal(result[1].role, 'assistant');
  });

  it('should merge consecutive same-role user messages', () => {
    const msgs = [
      { role: 'user', content: 'Part 1' },
      { role: 'user', content: 'Part 2' },
    ];
    const result = normalizeMessages(msgs);
    assert.equal(result.length, 1);
    assert.equal(result[0].role, 'user');
    assert.ok(result[0].content.includes('Part 1'));
    assert.ok(result[0].content.includes('Part 2'));
  });

  it('should merge consecutive same-role assistant messages (no tool_calls)', () => {
    const msgs = [
      { role: 'assistant', content: 'Part 1' },
      { role: 'assistant', content: 'Part 2' },
    ];
    const result = normalizeMessages(msgs);
    assert.equal(result.length, 1);
    assert.equal(result[0].role, 'assistant');
  });

  it('should reorder tool messages after assistant tool_calls', () => {
    const msgs = [
      { role: 'user', content: 'Calc 2+2' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'calc', arguments: '{"a":2,"b":2}' } }] },
      { role: 'tool', tool_call_id: 'tc1', content: '4' },
    ];
    const result = normalizeMessages(msgs);
    assert.equal(result.length, 3);
    assert.equal(result[1].role, 'assistant');
    assert.equal(result[1].tool_calls.length, 1);
    assert.equal(result[2].role, 'tool');
    assert.equal(result[2].tool_call_id, 'tc1');
  });

  it('should drop orphan tool messages (no matching tool_calls)', () => {
    const msgs = [
      { role: 'user', content: 'Hello' },
      { role: 'tool', tool_call_id: 'orphan1', content: 'no parent' },
    ];
    const result = normalizeMessages(msgs);
    assert.equal(result.length, 1);
    assert.equal(result[0].role, 'user');
  });

  it('should keep text-only assistant when preceded by tool message', () => {
    const msgs = [
      { role: 'user', content: 'Calc' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'calc', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'tc1', content: '4' },
      { role: 'assistant', content: 'Result is 4' },
    ];
    const result = normalizeMessages(msgs);
    // text-only assistant after tool message is kept (prev is tool, not assistant)
    assert.equal(result.length, 4);
  });

  it('should coerce tool_call arguments to strings when coerceStrings=true', () => {
    const msgs = [
      {
        role: 'assistant', tool_calls: [
          { id: 'tc1', type: 'function', function: { name: 'test', arguments: { key: 'value' } } },
          { id: 'tc2', type: 'function', function: { name: 'test2', arguments: undefined } },
          { id: 'tc3', type: 'function', function: { name: 'test3', arguments: '' } },
        ]
      },
      { role: 'tool', tool_call_id: 'tc1', content: { result: 'ok' } },
    ];
    const result = normalizeMessages(msgs, { coerceStrings: true });
    assert.equal(typeof result[0].tool_calls[0].function.arguments, 'string');
    assert.equal(result[0].tool_calls[1].function.arguments, '{}');
    assert.equal(result[0].tool_calls[2].function.arguments, '{}');
    assert.equal(typeof result[1].content, 'string');
  });

  it('should handle system/developer role -> user role conversion (handled upstream)', () => {
    const msgs = [
      { role: 'user', content: '[System Instructions] Be helpful' },
      { role: 'user', content: 'Hello' },
    ];
    const result = normalizeMessages(msgs);
    assert.equal(result.length, 1);
    assert.ok(result[0].content.includes('Be helpful'));
  });

  it('should handle multiple tool_calls with interleaved tool responses', () => {
    const msgs = [
      { role: 'assistant', content: null, tool_calls: [
        { id: 'a', type: 'function', function: { name: 'get_weather', arguments: '{"city":"NY"}' } },
        { id: 'b', type: 'function', function: { name: 'get_time', arguments: '{}' } },
      ]},
      { role: 'tool', tool_call_id: 'b', content: '10:00' },
      { role: 'tool', tool_call_id: 'a', content: 'Sunny' },
    ];
    const result = normalizeMessages(msgs);
    // Tool messages should be reordered to follow assistant tool_calls
    const tcRoles = result.map(m => m.role);
    const tcIdx = tcRoles.indexOf('assistant');
    assert.ok(tcIdx >= 0);
    assert.equal(result[tcIdx + 1].role, 'tool');
    assert.equal(result[tcIdx + 2].role, 'tool');
  });
});

// ---- Test resolveProviderForModel logic ----
// Note: This requires the full proxy.mjs context, so we test the imported functions directly.

// ---- Test normalizeModelId ----
import { normalizeModelId, parseCsv } from '../src/shared.mjs';

describe('normalizeModelId', () => {
  it('should normalize model IDs to lowercase', () => {
    assert.equal(normalizeModelId('DeepSeek-V4-Pro'), 'deepseek-v4-pro');
  });

  it('should handle whitespace', () => {
    assert.equal(normalizeModelId('  gpt-4  '), 'gpt-4');
  });

  it('should handle empty/null/undefined', () => {
    assert.equal(normalizeModelId(''), '');
    assert.equal(normalizeModelId(null), '');
    assert.equal(normalizeModelId(undefined), '');
  });
});

describe('parseCsv', () => {
  it('should split comma-separated values', () => {
    assert.deepEqual(parseCsv('a,b,c'), ['a', 'b', 'c']);
  });

  it('should deduplicate case-insensitively', () => {
    const result = parseCsv('A,b,a,B,c');
    assert.deepEqual(result, ['A', 'b', 'c']);
  });

  it('should handle empty strings', () => {
    assert.deepEqual(parseCsv(''), []);
    assert.deepEqual(parseCsv(',,a,,b,'), ['a', 'b']);
  });
});

// ---- Test applyEffortTranslation ----
import { applyEffortTranslation } from '../src/protocol.mjs';

describe('applyEffortTranslation', () => {
  it('should set thinking:disabled for effort=none', () => {
    const req = {};
    applyEffortTranslation(req, 'none', 'deepseek');
    assert.deepEqual(req.thinking, { type: 'disabled' });
  });

  it('should map minimal -> low for all providers', () => {
    for (const p of ['deepseek', 'mimo', 'openai']) {
      const req = {};
      applyEffortTranslation(req, 'minimal', p);
      assert.equal(req.reasoning_effort, 'low');
    }
  });

  it('should passthrough low/medium/high', () => {
    for (const e of ['low', 'medium', 'high']) {
      const req = {};
      applyEffortTranslation(req, e, 'deepseek');
      assert.equal(req.reasoning_effort, e);
    }
  });

  it('should clamp xhigh -> high for MiMo', () => {
    const req = {};
    applyEffortTranslation(req, 'xhigh', 'mimo');
    assert.equal(req.reasoning_effort, 'high');
  });

  it('should passthrough xhigh for DeepSeek', () => {
    const req = {};
    applyEffortTranslation(req, 'xhigh', 'deepseek');
    assert.equal(req.reasoning_effort, 'xhigh');
  });

  it('should be no-op when effort is null/undefined', () => {
    const req = { existing: true };
    applyEffortTranslation(req, null, 'deepseek');
    assert.deepEqual(req, { existing: true });
    applyEffortTranslation(req, undefined, 'deepseek');
    assert.deepEqual(req, { existing: true });
  });
});

// ---- Test contentHasUrl ----
import { contentHasUrl, conversationHasUrls } from '../src/shared.mjs';

describe('contentHasUrl', () => {
  it('should detect URLs in strings', () => {
    assert.ok(contentHasUrl('check https://example.com'));
    assert.ok(contentHasUrl('http://test.com/path'));
  });

  it('should detect URLs in content array (text type)', () => {
    assert.ok(contentHasUrl([{ type: 'text', text: 'visit https://example.com' }]));
  });

  it('should detect URLs in input_text type', () => {
    assert.ok(contentHasUrl([{ type: 'input_text', text: 'read https://docs.example.com' }]));
  });

  it('should return false for non-URL content', () => {
    assert.ok(!contentHasUrl('no url here'));
    assert.ok(!contentHasUrl([{ type: 'text', text: 'just text' }]));
    assert.ok(!contentHasUrl(null));
    assert.ok(!contentHasUrl(undefined));
  });
});

describe('conversationHasUrls', () => {
  it('should detect URLs in any message', () => {
    const msgs = [
      { role: 'user', content: 'hello' },
      { role: 'user', content: 'check https://example.com' },
    ];
    assert.ok(conversationHasUrls(msgs));
  });

  it('should return false when no URLs', () => {
    const msgs = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ];
    assert.ok(!conversationHasUrls(msgs));
  });
});

// ---- Test stripEndpointSuffix ----
import { stripEndpointSuffix, normalizeModelsUrl } from '../src/shared.mjs';

describe('stripEndpointSuffix', () => {
  it('should strip trailing slash', () => {
    assert.equal(stripEndpointSuffix('https://api.example.com/v1/'), 'https://api.example.com/v1');
  });

  it('should strip /chat/completions', () => {
    assert.equal(stripEndpointSuffix('https://api.example.com/v1/chat/completions'), 'https://api.example.com/v1');
  });

  it('should strip /embeddings', () => {
    assert.equal(stripEndpointSuffix('https://api.example.com/v1/embeddings'), 'https://api.example.com/v1');
  });
});

describe('normalizeModelsUrl', () => {
  it('should append /models to bare /v1 URL', () => {
    assert.equal(normalizeModelsUrl('https://api.example.com/v1'), 'https://api.example.com/v1/models');
  });

  it('should keep /v1/models as-is', () => {
    assert.equal(normalizeModelsUrl('https://api.example.com/v1/models'), 'https://api.example.com/v1/models');
  });

  it('should normalize /chat/completions URL', () => {
    assert.equal(normalizeModelsUrl('https://api.example.com/v1/chat/completions'), 'https://api.example.com/v1/models');
  });
});
