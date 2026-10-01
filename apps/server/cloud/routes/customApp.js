import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

import docxtopdf, { upload as docxUpload } from './docxtopdf.js';
import decryptpdf, { uploadDecryptPdf } from './decryptpdf.js';
import { deleteUserByAdmin, deleteUserPost } from './deleteAccount/deleteUser.js';
import { deleteUserGet } from './deleteAccount/deleteUserGet.js';
import { deleteUserOtp } from './deleteAccount/deleteUserOtp.js';
import { mcpHandler } from '../mcp/route.js';
import { router as oauthRouter } from './oauth.js';
import { v1 } from '../api/v1.js';
import { checkRateLimit, RATE_LIMIT_CODE } from '../parsefunction/authGuard.js';

export const app = express();

dotenv.config({ quiet: true });
app.use(cors());

/**
 * Body size caps, per route group.
 *
 * index.js deliberately does not body-parse these paths (see CUSTOM_ROUTE_PATHS
 * there), because a single 100 MB limit in front of everything let an
 * unauthenticated caller make the process buffer 100 MB on `/decryptpdf`,
 * `/delete-account/*` or `/mcp` before any credential was checked.
 *
 *   small  the account-deletion routes: a form post, a few hundred bytes.
 *   api    /v1 and /mcp: json, but `upload_document` / `update_draft` carry a
 *          base64 pdf, so roughly a 18 MB pdf at the default 25mb.
 *
 * `/docxtopdf` and `/decryptpdf` are multipart and handled by multer, which
 * enforces its own 50 MB file cap; no json parser runs on them at all.
 */
const SMALL_BODY_LIMIT = process.env.CUSTOM_ROUTE_BODY_LIMIT || '256kb';
const API_BODY_LIMIT = process.env.API_BODY_LIMIT || '72mb'; // a 50 MB PDF as base64 JSON; cloud/api/shared.js uses the same value
const smallJson = express.json({ limit: SMALL_BODY_LIMIT });
const smallForm = express.urlencoded({ limit: SMALL_BODY_LIMIT, extended: true });
const apiJson = express.json({ limit: API_BODY_LIMIT });

/**
 * A light per-IP speed bump in front of every custom route.
 *
 * None of these paths were throttled at all: `/decryptpdf` and `/docxtopdf` each
 * pin a 50 MB buffer and a LibreOffice process, and `/delete-account/:id/otp`
 * mails an OTP. The per-function limiter in authGuard covers what the cloud
 * functions do after authentication; this one covers the route itself, before
 * anything is parsed. Keyed on the client ip that `trust proxy` vouched for
 * (index.js sets x-real-ip from req.ip), so it is a speed bump for abuse rather
 * than a quota.
 */
const ROUTE_RATE_LIMIT = Number(process.env.CUSTOM_ROUTE_RATE_LIMIT || 120);
function rateLimitByIp(bucket, max) {
  return function (req, res, next) {
    const key = req.headers['x-real-ip'] || req.ip || req.socket?.remoteAddress || 'unknown';
    try {
      checkRateLimit(bucket, String(key), max);
      next();
    } catch (err) {
      if (err?.code === RATE_LIMIT_CODE) {
        res.set('Retry-After', '60');
        return res.status(429).json({ error: 'Too many requests. Please try again in a minute.' });
      }
      next(err);
    }
  };
}

app.post(
  '/docxtopdf',
  rateLimitByIp('route:docxtopdf', Number(process.env.DOCX2PDF_RATE_LIMIT || 20)),
  docxUpload.single('file'),
  docxtopdf
);
app.post(
  '/decryptpdf',
  rateLimitByIp('route:decryptpdf', Number(process.env.DECRYPTPDF_RATE_LIMIT || 20)),
  uploadDecryptPdf,
  decryptpdf
);
// Self-service account deletion. All three handlers demand either the signed,
// 24 h, single-use token from the emailed link (`?t=` or the form body) or a
// session for that same account, and answer 404 for an unknown userId and an
// unauthorised caller alike (cloud/lib/deletionToken.js). `/deleteuser/:userId`
// is the separate admin path and needs an admin session.
app.get('/delete-account/:userId', rateLimitByIp('route:delete', ROUTE_RATE_LIMIT), deleteUserGet);
app.post(
  '/delete-account/:userId/otp',
  rateLimitByIp('route:delete-otp', Number(process.env.DELETE_OTP_RATE_LIMIT || 20)),
  smallJson,
  smallForm,
  deleteUserOtp
);
app.post(
  '/delete-account/:userId',
  rateLimitByIp('route:delete', ROUTE_RATE_LIMIT),
  smallJson,
  smallForm,
  deleteUserPost
);
app.post(
  '/deleteuser/:userId',
  rateLimitByIp('route:deleteuser', ROUTE_RATE_LIMIT),
  smallJson,
  smallForm,
  deleteUserByAdmin
);

// Token-authenticated integrations: stateless MCP endpoint and REST API v1, and
// the OAuth server that lets MCP clients connect an account (./oauth.js).
app.use(oauthRouter);
app.all('/mcp', rateLimitByIp('route:mcp', ROUTE_RATE_LIMIT), apiJson, mcpHandler);
app.use('/v1', rateLimitByIp('route:v1', ROUTE_RATE_LIMIT), apiJson, v1);
