import type { Context } from 'hono';
import type { ZodType } from 'zod';
import type { AppEnvironment } from './module.js';

const DEFAULT_JSON_BODY_LIMIT = 512 * 1024;

function payloadTooLarge(maxBytes: number): HttpError {
  const label = maxBytes >= 1024 && maxBytes % 1024 === 0 ? `${maxBytes / 1024} KiB` : `${maxBytes} bytes`;
  return new HttpError(413, 'payload_too_large', `Request body exceeds ${label}`);
}

export class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 500 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function parseJson<T>(context: Context<AppEnvironment>, schema: ZodType<T>, maxBytes = DEFAULT_JSON_BODY_LIMIT): Promise<T> {
  const contentType = context.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') throw new HttpError(400, 'invalid_content_type', 'Content-Type must be application/json');

  const contentLength = Number(context.req.header('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw payloadTooLarge(maxBytes);
  }

  let body: unknown;
  try {
    const stream = context.req.raw.body;
    if (!stream) {
      body = JSON.parse('');
    } else {
      const reader = stream.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          if (value.byteLength > maxBytes - size) {
            try { await reader.cancel(); } catch { /* best effort */ }
            throw payloadTooLarge(maxBytes);
          }
          chunks.push(value);
          size += value.byteLength;
        }
      } finally {
        reader.releaseLock();
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      body = JSON.parse(new TextDecoder().decode(bytes));
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'invalid_json', 'Request body must be valid JSON');
  }
  const result = schema.safeParse(body);
  if (!result.success) throw new HttpError(422, 'validation_failed', result.error.issues[0]?.message ?? 'Invalid request');
  context.get('assertAuthorizationCurrent')?.();
  return result.data;
}
