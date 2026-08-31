/**
 * Offline-only fixtures used by the demo seed and its tests.  They are
 * deliberately data-only: no executable commands, provider tokens, node
 * credentials, or management secrets are included.
 */

export const FAKE_CLIPROXY_JSONL = [
  JSON.stringify({
    id: 'fixture-req-001',
    provider: 'openai',
    model: 'gpt-4o-mini',
    endpoint: '/v1/chat/completions',
    status: 200,
    usage: { inputTokens: 128, outputTokens: 64, cachedTokens: 32 },
    latencyMs: 418,
  }),
  JSON.stringify({
    id: 'fixture-req-002',
    provider: 'anthropic',
    model: 'claude-3-5-sonnet',
    endpoint: '/v1/messages',
    status: 429,
    error: { category: 'rate_limit', summary: 'fixture quota exhausted' },
    latencyMs: 92,
  }),
  JSON.stringify({
    id: 'fixture-req-003',
    provider: 'kimi',
    model: 'kimi-k2',
    endpoint: '/v1/chat/completions',
    status: 200,
    usage: { inputTokens: 96, outputTokens: 41 },
    latencyMs: 302,
  }),
].join('\n');

/** Backwards-compatible fixture aliases for callers writing demo docs/tests. */
export const FAKE_CLIPROXY_FIXTURE = FAKE_CLIPROXY_JSONL;

/** A deterministic runtime transcript consumed by the fake adapter in demos. */
export const FAKE_RUNTIME_SCENARIO = {
  scenario: 'demo-root-run',
  runtime: 'fake',
  sessions: [
    {
      id: 'fake-demo-root-session',
      turns: [
        {
          id: 'fake-demo-turn-1',
          input: 'Inspect the repository and propose a safe patch plan.',
          output: 'Fake response: repository inspected; plan is ready.',
          events: ['session.created', 'turn.started', 'message.delta', 'message.completed'],
        },
      ],
    },
  ],
} as const;

export const FAKE_RUNTIME_FIXTURE = FAKE_RUNTIME_SCENARIO;
