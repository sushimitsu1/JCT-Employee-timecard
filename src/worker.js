import { DEFAULT_PBKDF2_ITERATIONS } from './auth.js';
import { handleRequest } from './app.js';
import { createD1Adapter } from './db.js';

function jsonError(error) {
  return new Response(JSON.stringify({ error }), {
    status: 500,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

export default {
  async fetch(request, env) {
    if (!env.PIN_PEPPER || !env.SESSION_SECRET || env.PIN_PEPPER.length < 16 || env.SESSION_SECRET.length < 16) {
      console.error(JSON.stringify({ level: 'error', msg: 'missing_or_short_secret' }));
      return jsonError('server_misconfigured');
    }
    if (!env.DB) {
      console.error(JSON.stringify({ level: 'error', msg: 'missing_database' }));
      return jsonError('server_misconfigured');
    }
    const parsedIterations = Number(env.PIN_PBKDF2_ITERATIONS || DEFAULT_PBKDF2_ITERATIONS);
    const iterations = Number.isInteger(parsedIterations) && parsedIterations >= 100000
      ? parsedIterations
      : DEFAULT_PBKDF2_ITERATIONS;
    return handleRequest(request, {
      db: createD1Adapter(env.DB),
      pepper: env.PIN_PEPPER,
      sessionSecret: env.SESSION_SECRET,
      iterations,
      now: () => new Date(),
      assets: env.ASSETS,
    });
  },
};
