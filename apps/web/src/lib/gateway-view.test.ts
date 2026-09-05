import { describe, expect, it } from 'vitest';
import { summarizeUsage } from './gateway-view';
import type { Usage } from './gateway-types';

const row = { bucketStart: '2026-09-01T00:00:00Z', group: null, requests: 2, failures: 1, inputTokens: 10, outputTokens: 20, estimatedCostMicrousd: null, unpricedRequests: 2, averageDurationMs: null, measuredRequests: 0, averageTtftMs: null };
const usage = (items: Usage['items']): Usage => ({ bucket: 'day', groupBy: 'provider', truncated: false, items });

describe('Gateway usage summary', () => {
  it('distinguishes loading, no observations and unknown measurements', () => {
    expect(summarizeUsage(null)).toBeNull();
    expect(summarizeUsage(usage([]))).toMatchObject({ requests: 0, averageDurationMs: null, estimatedCostMicrousd: null, bars: [] });
    expect(summarizeUsage(usage([row]))).toMatchObject({ requests: 2, failures: 1, tokens: 30, averageDurationMs: null, estimatedCostMicrousd: null, unpricedRequests: 2 });
  });

  it('merges grouped periods and weights measured latency by request count', () => {
    const result = summarizeUsage(usage([
      { ...row, group: 'one', averageDurationMs: 100, measuredRequests: 2, estimatedCostMicrousd: 0, unpricedRequests: 0 },
      { ...row, group: 'two', requests: 6, failures: 0, averageDurationMs: 300, measuredRequests: 6, estimatedCostMicrousd: 60, unpricedRequests: 0 },
      { ...row, bucketStart: '2026-08-31T00:00:00Z' },
    ]));
    expect(result).toMatchObject({ requests: 10, failures: 2, averageDurationMs: 250, estimatedCostMicrousd: 60, measuredRequests: 8, unpricedRequests: 2, maxRequests: 8 });
    expect(result?.bars).toEqual([
      { bucketStart: '2026-08-31T00:00:00Z', requests: 2, failures: 1 },
      { bucketStart: '2026-09-01T00:00:00Z', requests: 8, failures: 1 },
    ]);
  });
});
