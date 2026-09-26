import dotenv from 'dotenv';
dotenv.config({ quiet: true });
import express from 'express';
import cors from 'cors';
import { ParseServer } from 'parse-server';
import path from 'path';
const __dirname = path.resolve();
import http from 'http';
import formData from 'form-data';
import Mailgun from 'mailgun.js';
import { ApiPayloadConverter } from 'parse-server-api-mail-adapter';
import S3Adapter from '@parse/s3-files-adapter';
import FSFilesAdapter from '@parse/fs-files-adapter';
import { app as customRoute } from './cloud/routes/customApp.js';
import { exec } from 'child_process';
import { createTransport } from 'nodemailer';
import { appName, cloudServerUrl, serverAppId, smtpenable, smtpsecure, useLocal } from './Utils.js';
import { SSOAuth, ssoEnabled } from './auth/authadapter.js';
import runDbMigrations from './migrationdb/index.js';
import { ensureSigningIdentity } from './cloud/lib/signingIdentity.js';
import { validateSignedLocalUrl } from './cloud/parsefunction/getSignedUrl.js';
import { configuredPublicOrigin, publicOriginFor } from './cloud/lib/publicUrl.js';
import { requestedFileUrl } from './cloud/lib/fileUrls.js';
import { createSite, resolveWebRoot, securityHeaders } from './cloud/lib/webApp.js';
import { startAutoReminderScheduler } from './cloud/jobs/autoReminders.js';

/**
 * Last-resort process guards.
 *
 * Several cloud functions used to fire promises without awaiting them (the
 * signing flow's certificate and completion mail among them). On node 18+ an
 * unhandled rejection terminates the process by default, so one failing mail
 * took the whole server down mid-signature with nothing in the logs. Log
 * loudly and keep serving instead; a genuinely broken process state
 * (uncaughtException) still exits so the supervisor restarts it.
 */
process.on('unhandledRejection', reason => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  console.error('[unhandledRejection]', err.message, '\n', err.stack);
});

process.on('uncaughtException', err => {
  console.error('[uncaughtException]', err?.message, '\n', err?.stack);
  // The process is no longer trustworthy; let the supervisor restart it.
  setTimeout(() => process.exit(1), 100).unref();
});

/**
 * Everything the S3 / Spaces files adapter cannot work without. The DO_* names
 * are historical; they hold the AWS S3 values just as well (DO_SPACE is the
 * bucket, DO_ENDPOINT the s3 endpoint host, DO_REGION the region).
 */
const S3_REQUIRED_ENV = [
  'DO_SPACE',
  'DO_REGION',
  'DO_ACCESS_KEY_ID',
  'DO_SECRET_ACCESS_KEY',
  'DO_ENDPOINT',
];

function localFilesAdapter() {
  return new FSFilesAdapter({
    filesSubDirectory: 'files', // optional, defaults to ./files
  });
}

/** Build the object-storage adapter, or throw naming what is missing. */
function buildS3Adapter() {
  const missing = S3_REQUIRED_ENV.filter(key => !process.env[key]?.trim?.());
  if (missing.length) {
    throw new Error(
      `object storage is not configured: ${missing.join(', ')} ${
        missing.length === 1 ? 'is' : 'are'
      } empty`
    );
  }
  const spacesEndpoint = process.env.DO_ENDPOINT.includes('http')
    ? process.env.DO_ENDPOINT
    : `https://${process.env.DO_ENDPOINT}`; //"e.g https://blr1.digitaloceanspaces.com"
  return new S3Adapter({
    bucket: process.env.DO_SPACE,
    baseUrl: process.env.DO_BASEURL,
    fileAcl: 'none',
    region: process.env.DO_REGION,
    directAccess: true,
    preserveFileName: true,
    presignedUrl: true,
    presignedUrlExpires: 900,
    s3overrides: {
      credentials: {
        accessKeyId: process.env.DO_ACCESS_KEY_ID,
        secretAccessKey: process.env.DO_SECRET_ACCESS_KEY,
      },
      endpoint: spacesEndpoint,
      signatureVersion: 'v4',
    },
  });
}

/**
 * Storing uploads on the container filesystem when object storage was meant to
 * be used loses every document on the next deploy, so a misconfigured S3 is
 * fatal rather than a silent downgrade. Local disk is only used when it was
 * asked for with USE_LOCAL=true (or under the test harness).
 */
let fsAdapter;
if (useLocal === 'true') {
  fsAdapter = localFilesAdapter();
} else if (process.env.TESTING) {
  // Specs never talk to object storage; keep the historic fall back to disk.
  try {
    fsAdapter = buildS3Adapter();
  } catch {
    fsAdapter = localFilesAdapter();
  }
} else {
  try {
    fsAdapter = buildS3Adapter();
  } catch (err) {
    console.error(`[files] ${err.message}`);
    console.error(
      '[files] refusing to start on local disk storage instead. Fix the credentials, or set USE_LOCAL=true to store files on the filesystem on purpose.'
    );
    process.exit(1);
  }
}

let transporterMail;
let mailgunClient;
let mailgunDomain;
let isMailAdapter = false;
if (smtpenable) {
  try {
    const transporterConfig = {
      host: process.env.SMTP_HOST,
      port: process.env.SMTP_PORT || 465,
      secure: smtpsecure,
    };

    // Auth whenever a password is set. The login defaults to the sender address
    // (SMTP_USER_EMAIL) when SMTP_USERNAME is not given, which is what most
    // providers expect; relays that take no auth leave SMTP_PASS empty.
    const smtpUser = process.env.SMTP_USERNAME || process.env.SMTP_USER_EMAIL;
    const smtpPass = process.env.SMTP_PASS;

    if (smtpUser && smtpPass) {
      transporterConfig.auth = { user: smtpUser, pass: smtpPass };
    }
    transporterMail = createTransport(transporterConfig);
    // The adapter is built because SMTP is configured, not because the mail host
    // answered at boot. verify() used to be awaited here, so an SES throttle or a
    // DNS blip during container start removed the emailAdapter block from the
    // Parse config for the whole life of the process: password reset and email
    // verification then failed with Parse's generic "no email adapter" error
    // until someone restarted it. It also blocked start-up entirely while a
    // hanging SMTP connect ran with no timeout. Verify in the background, with a
    // deadline, purely as a boot-time diagnostic.
    isMailAdapter = true;
    const verifyTimeoutMs = Number(process.env.SMTP_VERIFY_TIMEOUT_MS || 10000);
    Promise.race([
      transporterMail.verify(),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`smtp verify timed out after ${verifyTimeoutMs}ms`)),
          verifyTimeoutMs
        ).unref()
      ),
    ]).then(
      () => console.log('[mail] smtp transport verified'),
      err =>
        console.error(
          `[mail] smtp verify failed (mail is still enabled and will be retried per message): ${err?.message || err}`
        )
    );
  } catch (err) {
    isMailAdapter = false;
    console.error(`[mail] could not build the smtp transport: ${err?.message || err}`);
  }
} else if (process.env.MAILGUN_API_KEY) {
  try {
    const mailgun = new Mailgun(formData);
    mailgunClient = mailgun.client({
      username: 'api',
      key: process.env.MAILGUN_API_KEY,
    });
    mailgunDomain = process.env.MAILGUN_DOMAIN;
    isMailAdapter = true;
  } catch (error) {
    isMailAdapter = false;
    console.error(`[mail] could not build the mailgun client: ${error?.message || error}`);
  }
}
const mailsender = smtpenable ? process.env.SMTP_USER_EMAIL : process.env.MAILGUN_SENDER;

/* ------------------------------------------------------------------------- *
 * Log redaction
 * ------------------------------------------------------------------------- */

/** Metadata keys whose value must never reach a log line, on disk or stdout. */
const SECRET_LOG_KEYS =
  /(base64|password|passphrase|otp|token|secret|masterkey|apikey|access_key|signature|pfx|cert)/i;
const MAX_LOGGED_STRING = 512;

/** Deep copy of `value` with secret-bearing keys replaced and long strings cut. */
function redactLogValue(value, depth = 0) {
  if (depth > 4) return '[deep]';
  if (typeof value === 'string') {
    return value.length > MAX_LOGGED_STRING
      ? `${value.slice(0, MAX_LOGGED_STRING)}...[${value.length} chars]`
      : value;
  }
  if (Array.isArray(value)) return value.slice(0, 20).map(item => redactLogValue(item, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = SECRET_LOG_KEYS.test(key) ? '[redacted]' : redactLogValue(item, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * parse-server's own winston adapter, wrapped so every argument passes through
 * `redactLogValue` first. Without it a failed `fileupload` writes the whole
 * base64 document into ./logs, and a failed delete-account call writes the OTP.
 *
 * The adapter lives at a path parse-server does not re-export, so the import is
 * best effort: if it moves, we log the fact and fall back to the stock adapter
 * rather than failing to boot.
 */
const redactingLoggerAdapter = await (async () => {
  try {
    const { WinstonLoggerAdapter } =
      await import('parse-server/lib/Adapters/Logger/WinstonLoggerAdapter.js');
    const inner = new WinstonLoggerAdapter({
      logLevel: 'error',
      maxLogFiles: process.env.MAX_LOG_FILES || '7d',
    });
    return {
      log: (...args) => inner.log(...args.map(arg => redactLogValue(arg))),
      addTransport: transport => inner.addTransport(transport),
      query: (options, callback) => inner.query(options, callback),
    };
  } catch (err) {
    console.error(
      `[logs] could not install the redacting logger adapter, cloud-function params may be logged verbatim: ${err?.message || err}`
    );
    return null;
  }
})();

/**
 * Which source addresses may use the master key.
 *
 * parse-server's last line of defence: with the default below a leaked
 * MASTER_KEY is usable from anywhere on the internet rather than only from the
 * app host. It stays permissive by default because the master key is also used
 * by out-of-container tooling on some deployments (parse-dbtool over a tunnel,
 * a dashboard), and narrowing it silently would lock those out on upgrade.
 * Every deployment that does not need that should set:
 *
 *   MASTER_KEY_IPS=127.0.0.1,::1,172.16.0.0/12
 *
 * (the container's own addresses plus the compose network). The value is a
 * comma-separated list of addresses or CIDR ranges.
 *
 * Note that MASTER_KEY is also the HMAC key behind the /files/ signed urls
 * (cloud/parsefunction/getSignedUrl.js), so the two lifetimes are coupled:
 * rotating the master key invalidates every outstanding file url. Giving the
 * file urls their own secret is tracked separately.
 */
function masterKeyIpsSetting() {
  const raw = process.env.MASTER_KEY_IPS;
  const list = (raw || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  return list.length ? list : ['0.0.0.0/0', '::/0'];
}

/**
 * parse-server's own per-IP rate limits on the endpoints that matter.
 *
 * Nothing throttled the Parse REST surface before this: login, signup and
 * password reset were all unlimited, which makes credential stuffing and
 * password-reset mail flooding free. The in-memory limiter in authGuard covers
 * individual cloud functions after authentication; this covers the routes
 * themselves.
 *
 * `includeInternalRequests` stays false so the server's own loopback calls (the
 * PDF pipeline, the batch functions) are never counted, and the limits are
 * generous enough that a real user clicking around never meets them. Under
 * TESTING the whole thing is off, because a spec file legitimately logs in
 * dozens of times a second. Set PARSE_RATE_LIMIT=off to disable it entirely.
 */
function parseRateLimits() {
  if (process.env.TESTING || process.env.PARSE_RATE_LIMIT === 'off') return [];
  const minute = 60 * 1000;
  return [
    {
      requestPath: '/login',
      requestMethods: ['POST', 'GET'],
      requestTimeWindow: minute * 5,
      requestCount: Number(process.env.RATE_LIMIT_LOGIN || 30),
      errorResponseMessage: 'Too many login attempts. Please try again in a few minutes.',
      includeInternalRequests: false,
    },
    {
      requestPath: '/requestPasswordReset',
      requestMethods: ['POST'],
      requestTimeWindow: minute * 15,
      requestCount: Number(process.env.RATE_LIMIT_PASSWORD_RESET || 10),
      errorResponseMessage: 'Too many password reset requests. Please try again later.',
      includeInternalRequests: false,
    },
    {
      requestPath: '/users',
      requestMethods: ['POST'],
      requestTimeWindow: minute * 15,
      requestCount: Number(process.env.RATE_LIMIT_SIGNUP || 20),
      errorResponseMessage: 'Too many sign-up attempts. Please try again later.',
      includeInternalRequests: false,
    },
    {
      requestPath: '/functions/*',
      requestTimeWindow: minute,
      requestCount: Number(process.env.RATE_LIMIT_FUNCTIONS || 300),
      errorResponseMessage: 'Too many requests. Please try again in a minute.',
      includeInternalRequests: false,
    },
  ];
}

export const config = {
  databaseURI:
    process.env.DATABASE_URI || process.env.MONGODB_URI || 'mongodb://localhost:27017/dev',
  rateLimit: parseRateLimits(),
  // Returned, not dropped: parse-server awaits this promise, so cloud functions
  // and beforeSave/afterSave triggers are registered before the mount accepts a
  // request, and an import failure inside main.js surfaces as a startup error
  // instead of a context-free unhandled rejection.
  cloud: () => import('./cloud/main.js'),
  appId: serverAppId,
  logLevel: 'error',
  // parse-server logs every cloud function call together with its complete
  // params object in the log metadata (only the message string is truncated).
  // `fileupload` takes `fileBase64`, and the
  // account-deletion and OTP flows carry their codes, so one failure used to
  // write an entire document (or a live OTP) into ./logs. Keep the failure,
  // drop the payload (redactingLoggerAdapter), silence the success/trigger
  // lines that carry the same payloads, and cap what stays on disk.
  logLevels: {
    cloudFunctionError: process.env.PARSE_LOG_CLOUD_ERRORS || 'error',
    cloudFunctionSuccess: 'silent',
    triggerAfter: 'silent',
    triggerBeforeSuccess: 'silent',
  },
  ...(redactingLoggerAdapter ? { loggerAdapter: redactingLoggerAdapter } : {}),
  maxLogFiles: process.env.MAX_LOG_FILES || '7d',
  maxLimit: 500,
  maxUploadSize: '100mb',
  masterKey: process.env.MASTER_KEY, //Add your master key here. Keep it secret!
  masterKeyIps: masterKeyIpsSetting(),
  serverURL: cloudServerUrl, // Don't forget to change to https if needed
  verifyUserEmails: false,
  publicServerURL: process.env.SERVER_URL || cloudServerUrl,
  // Your apps name. This will appear in the subject and body of the emails that are sent.
  appName: appName,
  allowClientClassCreation: false,
  allowExpiredAuthDataToken: false,
  enableInsecureAuthAdapters: false,
  databaseOptions: { allowPublicExplain: false },
  encodeParseObjectInCloudFunction: true,
  ...(isMailAdapter === true
    ? {
        emailAdapter: {
          module: 'parse-server-api-mail-adapter',
          options: {
            // The email address from which emails are sent.
            sender: appName + ' <' + mailsender + '>',
            // The email templates.
            templates: {
              // The template used by Parse Server to send an email for password
              // reset; this is a reserved template name.
              passwordResetEmail: {
                subjectPath: './files/password_reset_email_subject.txt',
                textPath: './files/password_reset_email.txt',
                htmlPath: './files/password_reset_email.html',
              },
              // The template used by Parse Server to send an email for email
              // address verification; this is a reserved template name.
              verificationEmail: {
                subjectPath: './files/verification_email_subject.txt',
                textPath: './files/verification_email.txt',
                htmlPath: './files/verification_email.html',
              },
            },
            apiCallback: async ({ payload, locale }) => {
              if (mailgunClient) {
                const mailgunPayload = ApiPayloadConverter.mailgun(payload);
                await mailgunClient.messages.create(mailgunDomain, mailgunPayload);
              } else if (transporterMail) await transporterMail.sendMail(payload);
            },
          },
        },
      }
    : {}),
  filesAdapter: fsAdapter,
  // The sso adapter mints a session on the say-so of whatever host SSO_API_URL
  // names, so it is only registered when the operator named one on purpose.
  auth: {
    google: { clientId: process.env.GOOGLE_CLIENT_ID },
    ...(ssoEnabled ? { sso: SSOAuth } : {}),
  },
  // for fix Adapter prototype don't match expected prototype
  push: { queueOptions: { disablePushWorker: true } },
};
// Client-keys like the javascript key or the .NET key are not necessary with parse-server
// If you wish you require them, you can set them as options in the initialization above:
// javascriptKey, restAPIKey, dotNetKey, clientKey

export const app = express();

/**
 * How many reverse proxies sit in front of this process.
 *
 * `x-real-ip` (below) feeds the audit trail, the signing certificate and every
 * rate limit, so it must not be whatever the client typed into
 * `X-Forwarded-For`. Express only believes that header for as many hops as
 * `trust proxy` allows, so leave this at the default of 1 for the deploy/ setup
 * (Caddy in front of the container is exactly one hop). Set TRUST_PROXY=0 when
 * the process is exposed directly, or to a count / a subnet ('loopback',
 * '10.0.0.0/8', ...) matching your own topology.
 */
function trustProxySetting() {
  const raw = process.env.TRUST_PROXY;
  if (raw === undefined || raw.trim() === '') return 1;
  const value = raw.trim();
  if (/^\d+$/.test(value)) return Number(value);
  if (value.toLowerCase() === 'true') return true;
  if (value.toLowerCase() === 'false') return false;
  return value; // subnet(s), e.g. 'loopback, 10.0.0.0/8'
}
app.set('trust proxy', trustProxySetting());
app.disable('x-powered-by');
// Security headers on every response, including the 503s of the boot gate
// (cloud/lib/webApp.js).
app.use(securityHeaders);

/**
 * Which browser origins may script this API.
 *
 * `cors()` with no options answers every origin with `Access-Control-Allow-Origin: *`,
 * so any page on the internet could drive the Parse mount and the custom routes
 * with the (public) app id. The allowlist is the app's own origin plus anything
 * named in CORS_ORIGINS (comma separated). Set CORS_ORIGINS=* to restore the old
 * behaviour for a deployment that really does serve many front ends.
 *
 * Requests with no Origin header (server to server, curl, the container's own
 * loopback calls) are always allowed: CORS only constrains browsers.
 */
function corsOptions() {
  const configured = (process.env.CORS_ORIGINS || '')
    .split(',')
    .map(value => value.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  if (configured.includes('*')) return {};
  const allowed = new Set(configured);
  const publicOrigin = configuredPublicOrigin();
  if (publicOrigin) allowed.add(publicOrigin);
  if (!allowed.size) {
    // Nothing configured at all (local development): keep the permissive
    // behaviour rather than locking the developer out of their own dev server.
    return {};
  }
  return {
    origin(origin, callback) {
      if (!origin || allowed.has(origin.replace(/\/+$/, ''))) return callback(null, true);
      callback(null, false);
    },
  };
}

/**
 * Boot gate: outside traffic waits until the class migrations have run.
 *
 * `parse-dbtool migrate` drives this server's own REST API, so it can only run
 * once the socket is open, and until it finishes the CLPs and column definitions
 * every write depends on may still be the previous deploy's. Loopback callers
 * are let through because parse-dbtool itself is one, as are the server's own
 * internal REST calls. The gate opens on its own after MIGRATION_GATE_TIMEOUT_MS
 * so a stuck migration degrades to the old behaviour instead of a permanent 503.
 * Under TESTING nothing gates anything: the spec harness runs no migrations.
 */
let migrationsReady = Boolean(process.env.TESTING);
const LOOPBACK_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
function openTheGate(reason) {
  if (migrationsReady) return;
  migrationsReady = true;
  console.log(`[boot] accepting traffic (${reason})`);
}
if (!process.env.TESTING) {
  setTimeout(
    () => openTheGate('migration gate timed out'),
    Number(process.env.MIGRATION_GATE_TIMEOUT_MS || 120000)
  ).unref();
}
app.use(function (req, res, next) {
  if (migrationsReady) return next();
  const remote = req.socket?.remoteAddress || '';
  if (LOOPBACK_IPS.has(remote)) return next();
  res.set('Retry-After', '5');
  return res.status(503).json({ message: 'server is starting, please retry' });
});

app.use(cors(corsOptions()));

/**
 * Body size caps.
 *
 * Everything used to go through one `express.json({ limit: '100mb' })`, so an
 * unauthenticated caller could make any route on the process buffer 100 MB
 * before a single credential was looked at. The Parse mount is the one surface
 * that legitimately carries a whole document (`fileupload` posts a base64
 * pdf), and 72mb is what a 50 MB pdf needs
 * once base64 expansion (4/3) and the json envelope are counted.
 *
 * The custom routes are excluded here and set their own, much smaller limits in
 * cloud/routes/customApp.js; the two upload routes among them use multer,
 * which has its own 50 MB cap and never sees this parser.
 */
const PARSE_BODY_LIMIT = process.env.PARSE_BODY_LIMIT || '72mb';
const CUSTOM_ROUTE_PATHS = /^\/(docxtopdf|decryptpdf|delete-account|deleteuser|mcp|v1)(\/|$)/;
const parseJsonBody = express.json({ limit: PARSE_BODY_LIMIT });
const parseUrlencodedBody = express.urlencoded({ limit: PARSE_BODY_LIMIT, extended: true });
app.use(function (req, res, next) {
  if (CUSTOM_ROUTE_PATHS.test(req.path || '')) return next();
  parseJsonBody(req, res, err => (err ? next(err) : parseUrlencodedBody(req, res, next)));
});
app.use(function (req, res, next) {
  // req.ip is the left-most address X-Forwarded-For that `trust proxy` vouches
  // for, or the socket address. Downstream code reads the header, not req.ip.
  req.headers['x-real-ip'] = req.ip || req.socket?.remoteAddress || '';
  const publicUrl = publicOriginFor(req);
  if (publicUrl) req.headers['public_url'] = publicUrl;
  else delete req.headers['public_url'];
  next();
});

/**
 * The base the /files/ signed urls were minted against, resolved once at start-up.
 *
 * getSignedLocalUrl signs the whole url, so the string rebuilt here has to match
 * it exactly. SERVER_URL is the api url (e.g. https://sign.example.com/api/app):
 * strip the Parse mount off its path and what is left is the prefix in front of
 * the mount, `/api` in the Docker setup (requestedFileUrl puts it back when a
 * proxy stripped it before the request got here). That used to be a literal comparison against
 * `/api/app`, so every other mount shape 400'd on every file read, and
 * `new URL(undefined)` threw inside an async handler (a hung request) whenever
 * SERVER_URL was unset.
 */
const fileUrlBase = (() => {
  const raw = process.env.SERVER_URL?.trim();
  if (!raw) {
    console.error(
      '[files] SERVER_URL is not set, so signed file urls cannot be validated; /files/ reads will be refused.'
    );
    return null;
  }
  try {
    const serverUrl = new URL(raw);
    const mount = (process.env.PARSE_MOUNT || '/app').replace(/\/+$/, '');
    const pathname = serverUrl.pathname.replace(/\/+$/, '');
    // Normally the path ends with the configured mount. When it does not (the
    // spec harness mounts on /test, a deployment renamed the mount), the mount
    // is by definition the last path segment.
    const prefix =
      mount && pathname.endsWith(mount)
        ? pathname.slice(0, -mount.length)
        : pathname.slice(0, pathname.lastIndexOf('/'));
    return { origin: serverUrl.origin, prefix: prefix.replace(/\/+$/, '') };
  } catch (err) {
    console.error(`[files] SERVER_URL is not a valid url (${raw}): ${err?.message}`);
    return null;
  }
})();

app.use(async function (req, res, next) {
  const isFilePath = req.path?.includes('/files/') || false;
  const method = req.method?.toLowerCase();
  // Express routes HEAD through the GET handler, so a HEAD that skipped this
  // gate confirmed the existence and size of any stored document by name.
  if (isFilePath && (method === 'get' || method === 'head')) {
    if (!fileUrlBase) return res.status(500).json({ message: 'file access is not configured' });
    const fileUrl = requestedFileUrl(req.originalUrl, fileUrlBase);
    const params = fileUrl?.split('?')?.[1];
    if (params) {
      const fileRes = await validateSignedLocalUrl(fileUrl);
      if (fileRes === 'Unauthorized') {
        return res.status(400).json({ message: 'unauthorized' });
      }
    } else {
      return res.status(400).json({ message: 'unauthorized' });
    }
    next();
  } else {
    next();
  }
});

// Serve static assets from the /public folder
app.use('/public', express.static(path.join(__dirname, '/public')));

// Serve the Parse API on the /parse URL prefix
if (!process.env.TESTING) {
  const mountPath = process.env.PARSE_MOUNT || '/app';
  try {
    const server = new ParseServer(config);
    await server.start();
    app.use(mountPath, server.app);
  } catch (err) {
    // Exit non-zero: with a bare process.exit() a fatal misconfiguration exited
    // 0, so docker restart policies, systemd and CI deploy checks all read a
    // dead server as a clean shutdown and reported the deploy green.
    console.error('[boot] Parse Server failed to start:', err?.message || err, '\n', err?.stack);
    process.exit(1);
  }
}
// Mount your custom express app
app.use('/', customRoute);

// Parse Server plays nicely with the rest of your web routes
app.get('/', function (req, res) {
  res.status(200).send('docustamp-server is running !!!');
});

if (!process.env.TESTING) {
  const port = process.env.PORT || 8080;

  // The index migrations talk to Mongo directly, so they can (and now do) finish
  // before the socket is open. They used to be fired without `await` from inside
  // the listen callback, so nothing observed a rejection and the server served
  // traffic while the unique indexes were still being built. A failure is logged
  // loudly but does not stop the boot: a server that refuses to start is worse
  // than one running with an index missing.
  await runDbMigrations().catch(err =>
    console.error('[migrations] index migrations failed:', err?.message || err)
  );

  // With the built web app next to it (the Docker image), this process serves
  // the whole site; otherwise just the API (cloud/lib/webApp.js).
  const webRoot = resolveWebRoot();
  const site = webRoot
    ? createSite(app, webRoot, { parseMount: process.env.PARSE_MOUNT || '/app' })
    : app;
  console.log(
    webRoot ? `[boot] serving the web app from ${webRoot}` : '[boot] serving the API only'
  );
  const httpServer = http.createServer(site);
  // Node requires headersTimeout to exceed keepAliveTimeout: when they are equal
  // a keep-alive connection can be closed at the exact moment a new request is
  // arriving, and the client (or the proxy in front) sees ECONNRESET instead of
  // a response. Leave the few seconds of slack in place.
  httpServer.keepAliveTimeout = 100000; // in milliseconds
  httpServer.headersTimeout = 105000; // in milliseconds
  httpServer.listen(port, '0.0.0.0', async function () {
    console.log('docustamp-server running on port ' + port + '.');
    // `parse-dbtool` is a separate process that drives this server's own REST
    // API, so unlike the index migrations it cannot run before the socket is
    // open. The gate above keeps outside traffic out until it is done, which is
    // what stops a document being written before its class permissions and
    // triggers are in place.
    await runClassMigrations();
    // A fresh install without PFX_BASE64 gets a stored self-signed certificate,
    // so its first signature does not fail (cloud/lib/signingIdentity.js).
    await ensureSigningIdentity().catch(err =>
      console.error('[signing] could not prepare a signing certificate:', err?.message || err)
    );
    openTheGate('class migrations finished');
    // Hourly sweep for documents whose automatic reminder is due.
    startAutoReminderScheduler();
  });
}

/** Runs `parse-dbtool migrate` (databases/migrations) and reports honestly. */
function runClassMigrations() {
  return new Promise(resolve => {
    // The master key goes through the child's environment, never the command
    // line, where it would show up in `ps` output and in any shell history or
    // log that captures the command. One command works on every platform.
    exec(
      'npx parse-dbtool migrate',
      {
        env: {
          ...process.env,
          APPLICATION_ID: serverAppId,
          SERVER_URL: cloudServerUrl,
          MASTER_KEY: process.env.MASTER_KEY,
        },
      },
      (error, stdout, stderr) => {
        // parse-dbtool writes progress to stderr, so stderr alone is not a
        // failure; only a non-zero exit is.
        if (stdout) console.log(`parse-dbtool: ${stdout}`);
        if (stderr) console.warn(`parse-dbtool (stderr): ${stderr}`);
        if (error) console.error(`parse-dbtool migrate failed: ${error.message}`);
        resolve();
      }
    );
  });
}
