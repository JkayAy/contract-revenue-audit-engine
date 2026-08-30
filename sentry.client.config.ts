// This file configures the initialization of Sentry on the client/browser
// bundle. It runs whenever a user loads a page in their browser, per the
// @sentry/nextjs convention for the App Router.
//
// See https://docs.sentry.io/platforms/javascript/guides/nextjs/ for the
// full set of options. Only a minimal, production-safe configuration is
// enabled here: error capture and light performance tracing. Session
// replay and profiling are intentionally left disabled to avoid shipping
// unnecessary client bundle weight and cost in this showcase deployment.
import * as Sentry from "@sentry/nextjs";

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

Sentry.init({
  dsn,
  enabled: Boolean(dsn),
  environment: process.env.NODE_ENV,

  // Capture 10% of transactions for performance monitoring. This keeps
  // the Sentry quota usage predictable in a low-traffic showcase
  // deployment while still surfacing real latency data.
  tracesSampleRate: 0.1,

  // Silence noisy dev-only warnings in the browser console.
  debug: false,
});
