import dotenv from 'dotenv';

/**
 * Settings a hosting platform already knows, filled in when they are left
 * empty, so a one-click deploy needs almost no typing:
 *
 *   PUBLIC_URL   the platform's public address: Railway RAILWAY_PUBLIC_DOMAIN,
 *                Render RENDER_EXTERNAL_URL, Fly.io FLY_APP_NAME (<app>.fly.dev)
 *   SERVER_URL   PUBLIC_URL + /api + the Parse mount, where the single-container
 *                image serves the API (cloud/lib/webApp.js)
 *   MONGODB_URI  Railway's MongoDB service (MONGO_URL), pointed at a docustamp
 *                database and at the admin auth source its root user lives in
 *
 * Anything set explicitly wins; a custom domain is set as PUBLIC_URL.
 *
 * index.js imports this module first, so the values are in place before any
 * other module reads them at import time. It loads .env itself for the same
 * reason.
 */

const clean = value => (typeof value === 'string' ? value.trim().replace(/\/+$/, '') : '');

/** The public https origin the platform assigned, or ''. */
export function platformOrigin(env) {
  const railway = clean(env.RAILWAY_PUBLIC_DOMAIN);
  if (railway) return /^https?:\/\//.test(railway) ? railway : `https://${railway}`;
  const render = clean(env.RENDER_EXTERNAL_URL);
  if (render) return render;
  const fly = clean(env.FLY_APP_NAME);
  if (fly) return `https://${fly}.fly.dev`;
  return '';
}

/**
 * A MongoDB connection string with a database name. Railway's MONGO_URL has
 * none (the driver would fall back to a database called "test") and
 * authenticates its root user against "admin", which naming a database would
 * otherwise change.
 */
export function withDatabase(uri, database = 'docustamp') {
  const [base, query = ''] = String(uri).trim().split('?');
  const rest = base.replace(/^[a-z+]+:\/\//i, '');
  const slash = rest.indexOf('/');
  const authority = slash === -1 ? rest : rest.slice(0, slash);
  if (slash !== -1 && rest.slice(slash + 1)) return String(uri).trim();
  const params = new URLSearchParams(query);
  if (authority.includes('@') && !params.has('authSource')) params.set('authSource', 'admin');
  const search = params.toString();
  return `${base.replace(/\/+$/, '')}/${database}${search ? `?${search}` : ''}`;
}

/** The values to fill in for `env`, without touching it. */
export function platformDefaults(env) {
  const defaults = {};
  const publicUrl = clean(env.PUBLIC_URL) || platformOrigin(env);
  if (publicUrl && !clean(env.PUBLIC_URL)) defaults.PUBLIC_URL = publicUrl;
  if (publicUrl && !clean(env.SERVER_URL)) {
    const mount = `/${clean(env.PARSE_MOUNT || '/app').replace(/^\/+/, '')}`;
    defaults.SERVER_URL = `${publicUrl}/api${mount}`;
  }
  if (!clean(env.MONGODB_URI) && !clean(env.DATABASE_URI) && clean(env.MONGO_URL)) {
    defaults.MONGODB_URI = withDatabase(env.MONGO_URL);
  }
  return defaults;
}

dotenv.config({ quiet: true });
if (!process.env.TESTING) {
  const defaults = platformDefaults(process.env);
  Object.assign(process.env, defaults);
  const filled = Object.keys(defaults);
  if (filled.length) {
    console.log(
      `[boot] from the hosting platform: ${filled.join(', ')}` +
        (defaults.PUBLIC_URL ? ` (public address ${defaults.PUBLIC_URL})` : '')
    );
  }
}
