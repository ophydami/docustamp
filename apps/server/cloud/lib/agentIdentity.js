/**
 * Who an AI agent is, and whether the person it acts for can be trusted to be
 * who their account says.
 *
 * An agent signs only for the account that connected it (see lib/agentSign.js).
 * That is only worth something when the account's address is really theirs:
 * signup does not verify email (index.js `verifyUserEmails: false`), so an
 * account could be opened in someone else's name and then have its agent sign
 * whatever is sent to that address. Agent signing therefore needs a verified
 * address that is also the one the account signs in with and the one its
 * profile shows. A `beforeSave` on `_User` keeps a client from changing the
 * address after it was verified.
 */
import { normaliseEmail } from './email.js';

/**
 * The agent behind a caller, as recorded in the audit trail and the certificate.
 * `name` is what the app called itself when it registered (self-declared, e.g.
 * "ChatGPT"); `host` is where its sign-in redirected to, which it cannot fake,
 * so the two are always shown together.
 *
 * @param {Object} caller from lib/context.js loadCaller (plus `oauth` for apps)
 * @returns {{kind: 'oauth'|'api_token', clientId: string, name: string, host: string}}
 */
export function agentIdentity(caller) {
  if (caller?.oauth) {
    return {
      kind: 'oauth',
      clientId: String(caller.oauth.clientId || ''),
      name: String(caller.oauth.clientName || '').trim() || 'AI app',
      host: String(caller.oauth.redirectHost || '').trim(),
    };
  }
  // A personal API key does not say which program holds it (Claude Code, a
  // script), so it is named generically: "Signed via AI agent for Jane Doe".
  return { kind: 'api_token', clientId: '', name: 'AI agent', host: '' };
}

/**
 * "ChatGPT (chatgpt.com)", or just the name when there is no host.
 * @param {{name?: string, host?: string}} agent
 */
export function agentLabel(agent) {
  const name = String(agent?.name || 'AI agent');
  return agent?.host ? `${name} (${agent.host})` : name;
}

/** Where a user goes to verify their address. Keep in step with the web app. */
export const VERIFY_EMAIL_HINT =
  'Verify your email address in DocuStamp first: Settings > API and MCP > Verify email.';

/**
 * Why this caller may not have an agent sign for them, or null when they may.
 * Requires `emailVerified`, and the sign-in address, the account email and the
 * profile email to be the same address.
 *
 * @param {Object} caller from loadCaller; `caller.user` is the `_User`.
 * @returns {string|null}
 */
export function verifiedIdentityProblem(caller) {
  const user = caller?.user;
  if (!user?.get) return 'This account could not be identified.';
  if (user.get('emailVerified') !== true) return VERIFY_EMAIL_HINT;
  const username = normaliseEmail(user.get('username'));
  const email = normaliseEmail(user.get('email'));
  const profile = normaliseEmail(caller.email);
  if (!username || username !== email || email !== profile) {
    return 'Your sign-in address and your profile address differ, so an agent cannot sign for you. Contact support.';
  }
  return null;
}
