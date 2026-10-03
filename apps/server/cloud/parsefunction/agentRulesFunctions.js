import { loadCaller } from '../lib/context.js';
import { describeRules, getAgentRules, setAgentRules } from '../lib/agentRules.js';
import { checkRateLimit } from './authGuard.js';

/**
 * The web app's side of "Rules for your AI" (cloud/lib/agentRules.js).
 *
 *   getagentrules  -> { rules, summary: string[] }
 *   setagentrules  { rules } -> { rules, summary: string[] }
 *                  sections left out keep their current values; anything that
 *                  is not a valid rule is refused with a message saying why
 *
 * Both need a person signed in to the web app. An app the user connected and
 * the API key reach DocuStamp through cloud/mcp/route.js, never these, so an
 * agent can read its rules (the get_rules tool) but has no way to change them.
 */

const PER_USER_PER_MIN = 30;

function requireUser(request) {
  if (!request?.user) {
    throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'User is not authenticated.');
  }
  checkRateLimit('agent-rules', `u:${request.user.id}`, PER_USER_PER_MIN);
}

export async function getAgentRulesFn(request) {
  requireUser(request);
  const rules = await getAgentRules(request.user.id);
  return { rules, summary: describeRules(rules) };
}

export async function setAgentRulesFn(request) {
  requireUser(request);
  // loadCaller refuses a suspended account and gives the name and address the
  // rules are recorded as set by.
  const caller = await loadCaller(request.user, { publicUrl: request.headers?.public_url });
  const rules = await setAgentRules(caller, request.params?.rules);
  return { rules, summary: describeRules(rules) };
}
