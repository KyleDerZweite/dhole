import type { MiddlewareHandler } from 'hono';
import type { AppConfig } from './config.js';
import type { IdSource } from './clock.js';
import { HttpError } from './http.js';
import type { AppEnvironment } from './module.js';

const unsafeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function baseSecurityMiddleware(config: AppConfig, ids: IdSource): MiddlewareHandler<AppEnvironment> {
  return async (context, next) => {
    const requestId = ids.id();
    context.set('requestId', requestId);
    const host = (context.req.header('host') ?? '').split(':')[0]?.toLowerCase() ?? '';
    if (!config.allowedHosts.has(host)) throw new HttpError(403, 'host_denied', 'Request host is not allowed');

    const origin = context.req.header('origin');
    const hasCookie = Boolean(context.req.header('cookie'));
    if (origin && unsafeMethods.has(context.req.method) && hasCookie && origin !== config.publicOrigin.origin) {
      throw new HttpError(403, 'origin_denied', 'Request origin is not allowed');
    }

    await next();
    context.header('X-Request-Id', requestId);
    context.header('X-Content-Type-Options', 'nosniff');
    context.header('X-Frame-Options', 'DENY');
    context.header('Referrer-Policy', 'no-referrer');
    context.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    context.header('Cross-Origin-Opener-Policy', 'same-origin');
    context.header('Content-Security-Policy', "default-src 'self'; base-uri 'none'; connect-src 'self' ws: wss:; font-src 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'");
    if (config.environment === 'production') context.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  };
}
