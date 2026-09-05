import type { Usage } from './gateway-types';

export function summarizeUsage(usage: Usage | null) {
  if (!usage) return null;
  const periods = new Map<string, { bucketStart: string; requests: number; failures: number }>();
  let requests = 0, failures = 0, tokens = 0, estimatedCostMicrousd = 0, priced = false;
  let unpricedRequests = 0, measuredRequests = 0, duration = 0;
  for (const item of usage.items) {
    requests += item.requests; failures += item.failures; tokens += item.inputTokens + item.outputTokens;
    unpricedRequests += item.unpricedRequests;
    if (item.estimatedCostMicrousd !== null) { priced = true; estimatedCostMicrousd += item.estimatedCostMicrousd; }
    if (item.averageDurationMs !== null && item.measuredRequests > 0) {
      measuredRequests += item.measuredRequests;
      duration += item.averageDurationMs * item.measuredRequests;
    }
    const period = periods.get(item.bucketStart) ?? { bucketStart: item.bucketStart, requests: 0, failures: 0 };
    period.requests += item.requests; period.failures += item.failures; periods.set(item.bucketStart, period);
  }
  const bars = [...periods.values()].sort((a, b) => a.bucketStart.localeCompare(b.bucketStart)).slice(-14);
  return { requests, failures, tokens, estimatedCostMicrousd: priced ? estimatedCostMicrousd : null,
    unpricedRequests, averageDurationMs: measuredRequests ? duration / measuredRequests : null,
    measuredRequests, bars, maxRequests: Math.max(1, ...bars.map((item) => item.requests)) };
}
