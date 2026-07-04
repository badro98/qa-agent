import { describe, it, expect } from 'vitest';
import { extractJson, callClaudeJson } from '../json.js';

describe('extractJson', () => {
  it('parses a bare JSON object', () => {
    expect(extractJson('{"covered": [], "gaps": []}')).toEqual({ covered: [], gaps: [] });
  });

  it('parses JSON wrapped in a ```json fence', () => {
    const raw = '```json\n{"covered": ["a.js"], "gaps": []}\n```';
    expect(extractJson(raw)).toEqual({ covered: ['a.js'], gaps: [] });
  });

  it('parses JSON wrapped in a bare ``` fence', () => {
    const raw = '```\n{"covered": [], "gaps": [{"file": "b.js"}]}\n```';
    expect(extractJson(raw)).toEqual({ covered: [], gaps: [{ file: 'b.js' }] });
  });

  it('parses JSON surrounded by prose', () => {
    const raw = 'Here is the coverage analysis:\n\n{"covered": [], "gaps": []}\n\nLet me know if you need anything else.';
    expect(extractJson(raw)).toEqual({ covered: [], gaps: [] });
  });

  it('parses JSON when trailing prose contains a closing brace', () => {
    const raw = 'Sure! {"covered": ["a.js"], "gaps": []} — note the shape is { covered, gaps }.';
    expect(extractJson(raw)).toEqual({ covered: ['a.js'], gaps: [] });
  });

  it('handles braces and escapes inside string values', () => {
    const raw = 'Result: {"gaps": [{"file": "src/{id}.js", "note": "quote \\" and brace }"}]}';
    expect(extractJson(raw)).toEqual({ gaps: [{ file: 'src/{id}.js', note: 'quote " and brace }' }] });
  });

  it('skips a prose brace before the real JSON object', () => {
    const raw = 'The shape is { covered, gaps }: {"covered": [], "gaps": []}';
    expect(extractJson(raw)).toEqual({ covered: [], gaps: [] });
  });

  it('throws on a truncated response', () => {
    const raw = '```json\n{"covered": ["a.js"], "gaps": [{"file": "b.js", "missing_test_types": ["unit"';
    expect(() => extractJson(raw)).toThrow(/no valid JSON/i);
  });

  it('throws when there is no JSON at all', () => {
    expect(() => extractJson('I could not produce the analysis.')).toThrow(/no valid JSON/i);
  });
});

describe('callClaudeJson', () => {
  const params = { systemPrompt: 'sys', userMessage: 'msg', maxTokens: 4096, label: 'analyzeCoverage' };

  it('returns parsed JSON on the first attempt without retrying', async () => {
    let calls = 0;
    const callFn = async () => { calls++; return '{"covered": [], "gaps": []}'; };
    const result = await callClaudeJson(params, { callFn });
    expect(result).toEqual({ covered: [], gaps: [] });
    expect(calls).toBe(1);
  });

  it('retries once when the first response is unparseable', async () => {
    let calls = 0;
    const callFn = async () => {
      calls++;
      if (calls === 1) return '```json\n{"covered": ["a.js"'; // truncated
      return '{"covered": ["a.js"], "gaps": []}';
    };
    const result = await callClaudeJson(params, { callFn });
    expect(result).toEqual({ covered: ['a.js'], gaps: [] });
    expect(calls).toBe(2);
  });

  it('throws a labeled error after two unparseable responses', async () => {
    let calls = 0;
    const callFn = async () => { calls++; return 'not json at all'; };
    await expect(callClaudeJson(params, { callFn }))
      .rejects.toThrow('analyzeCoverage: Claude response is not valid JSON');
    expect(calls).toBe(2);
  });
});
