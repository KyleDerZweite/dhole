import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { HttpError, parseJson } from './http.js';
import type { AppEnvironment } from './module.js';

const bodySchema = z.object({ value: z.string() });

function testApp(maxBytes?: number): Hono<AppEnvironment> {
  const app = new Hono<AppEnvironment>();
  app.post('/', async (context) => {
    try {
      return context.json(await parseJson(context, bodySchema, maxBytes));
    } catch (error) {
      if (error instanceof HttpError) return context.json({ error: error.code, message: error.message }, error.status);
      throw error;
    }
  });
  return app;
}

describe('parseJson', () => {
  it('parses application/json with a charset parameter', async () => {
    const response = await testApp().request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ value: 'ok' }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ value: 'ok' });
  });

  it('rejects non-JSON content types before reading the body', async () => {
    const response = await testApp().request('/', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ value: 'ok' }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: 'invalid_content_type' });
  });

  it('bounds a chunked body even when Content-Length is below the limit', async () => {
    let cancelled = false;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"value":"ok"}'));
        controller.enqueue(encoder.encode('x'.repeat(64)));
      },
      cancel() {
        cancelled = true;
      },
    });
    const requestInit: RequestInit & { duplex: 'half' } = {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': '1' },
      body: stream,
      duplex: 'half',
    };
    const request = new Request('http://localhost/', requestInit);

    const response = await testApp(32).fetch(request);

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ error: 'payload_too_large' });
    expect(cancelled).toBe(true);
  });

  it('maps malformed and empty bodies to invalid_json', async () => {
    const app = testApp();
    for (const body of ['{', '']) {
      const response = await app.request('/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: 'invalid_json' });
    }
  });

  it('retains Zod validation errors', async () => {
    const response = await testApp().request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 3 }),
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ error: 'validation_failed' });
  });
});
