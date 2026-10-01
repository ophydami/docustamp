import { decideApproval, getApproval, getApprovalPage, listApprovals } from '../lib/approvals.js';
import { loadCaller } from '../lib/context.js';
import { checkRateLimit, clientIp } from './authGuard.js';

/**
 * The web app's side of agent approvals (cloud/lib/approvals.js): the
 * Approvals page, where the user approves or declines a signature their AI
 * agent asked to make on a document someone else sent them.
 *
 *   listsignapprovals  { status?: 'pending'|'all' } -> { approvals: Approval[] }
 *   getsignapproval    { id } -> Approval
 *   getsignapprovalpage { id, page } -> { image, page, pageCount }
 *                      one page as a PNG data url, the user's own fields drawn
 *   decidesignapproval { id, decision: 'approve'|'decline' } -> Approval
 *                      approving signs right away; the result says signed,
 *                      declined or failed (with `error`)
 *
 * All of them need a signed-in user, and the approval must be theirs (anyone
 * else's reads as "Approval not found.").
 */

const PER_USER_PER_MIN = 60;
const PAGES_PER_USER_PER_MIN = 30;

/**
 * The caller with a freshly read `_User`: approving signs, and whether the
 * email is verified decides that; the session's copy of the user can predate
 * the verification.
 */
async function sessionCaller(request, bucket = 'sign-approvals', max = PER_USER_PER_MIN) {
  if (!request?.user) {
    throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'User is not authenticated.');
  }
  checkRateLimit(bucket, `u:${request.user.id}`, max);
  const user = await new Parse.Query(Parse.User).get(request.user.id, { useMasterKey: true });
  const caller = await loadCaller(user, { publicUrl: request.headers?.public_url });
  // The signing IP in the audit trail, as for a signature made from the web.
  const ip = clientIp(request);
  caller.ip = ip === 'unknown' ? '' : ip;
  return caller;
}

export async function listSignApprovals(request) {
  const caller = await sessionCaller(request);
  return { approvals: await listApprovals(caller, { status: request.params?.status }) };
}

export async function getSignApproval(request) {
  const caller = await sessionCaller(request);
  return await getApproval(caller, request.params?.id);
}

export async function getSignApprovalPage(request) {
  const caller = await sessionCaller(request, 'sign-approval-pages', PAGES_PER_USER_PER_MIN);
  return await getApprovalPage(caller, request.params?.id, request.params?.page);
}

export async function decideSignApproval(request) {
  const caller = await sessionCaller(request);
  return await decideApproval({
    approvalId: request.params?.id,
    decision: request.params?.decision,
    via: 'web',
    caller,
  });
}
