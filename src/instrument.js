// Sentry init — must run before any other imports so the SDK can patch
// node internals before they're loaded. server.js imports this as its
// very first line. Fail-open when SENTRY_DSN is unset (local dev,
// Electron desktop) so nothing crashes; only enabled in production.
import * as Sentry from '@sentry/node';

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'development',
    // Sample 100% of errors. Render endpoints are low-traffic and we want
    // every failure. Bump if/when traffic grows.
    tracesSampleRate: 0,
    // Don't include request bodies — they contain image bytes, not useful
    // and balloons event size.
    sendDefaultPii: false,
  });
}
