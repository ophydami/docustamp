import Anthropic from '@anthropic-ai/sdk';
import { AnthropicBedrock, AnthropicBedrockMantle } from '@anthropic-ai/bedrock-sdk';

/**
 * Claude client selection.
 *
 *   AI_PROVIDER   "bedrock" (default when AWS credentials/region are around) or "anthropic"
 *   AI_MODEL      model id; defaults to Claude Sonnet 4.6
 *                 Bedrock:  a cross-region InvokeModel id such as "us.anthropic.claude-sonnet-4-6"
 *                           (default), or a bare Messages-API id such as "anthropic.claude-sonnet-5"
 *                           once the account has access to it
 *                 Anthropic: "claude-sonnet-4-6"
 *   AI_REGION     AWS region for Bedrock (falls back to AWS_REGION, then us-east-1)
 *   AI_ENABLED    "true" or "false" forces AI on or off. When unset, AI is on only
 *                 once a provider is configured (ANTHROPIC_API_KEY, AI_PROVIDER or
 *                 AWS_BEARER_TOKEN_BEDROCK), so a fresh self-hosted install does
 *                 not offer features that would fail on first use.
 *
 * Bedrock credentials come from the usual AWS chain (AWS_ACCESS_KEY_ID /
 * AWS_SECRET_ACCESS_KEY, profile, instance role) or AWS_BEARER_TOKEN_BEDROCK.
 */

const DEFAULT_BEDROCK_MODEL = 'us.anthropic.claude-sonnet-4-6';
const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-6';

/** The only values AI_PROVIDER may take; anything else is a misconfiguration. */
const PROVIDERS = ['bedrock', 'anthropic'];
let warnedProvider = '';

/** Bare `anthropic.claude-<family>-<major>[-<minor>]` ids live on the Messages-API endpoint. */
const MANTLE_MODEL_RE = /^anthropic\.claude-[a-z]+-\d+(?:-\d+)?$/;

let cached = null;
let override = null;

/** Test seam: inject a fake `{ messages: { create } }`. */
export function setAiClientForTests(fake) {
  override = fake;
  cached = null;
}

export function aiConfig() {
  const flag = String(process.env.AI_ENABLED ?? '').trim().toLowerCase();
  const configured = Boolean(
    process.env.ANTHROPIC_API_KEY ||
      process.env.AI_PROVIDER?.trim() ||
      process.env.AWS_BEARER_TOKEN_BEDROCK
  );
  const enabled = flag ? flag !== 'false' : configured;
  const explicit = (process.env.AI_PROVIDER || '').trim().toLowerCase();
  if (explicit && !PROVIDERS.includes(explicit) && warnedProvider !== explicit) {
    warnedProvider = explicit;
    console.log(
      `ai: AI_PROVIDER="${explicit}" is not one of ${PROVIDERS.join(', ')}; falling back to bedrock.`
    );
  }
  const hasAnthropicKey = Boolean(process.env.ANTHROPIC_API_KEY);
  const provider = PROVIDERS.includes(explicit)
    ? explicit
    : hasAnthropicKey && !process.env.AI_MODEL?.includes('anthropic.')
      ? 'anthropic'
      : 'bedrock';
  const model =
    process.env.AI_MODEL ||
    (provider === 'anthropic' ? DEFAULT_ANTHROPIC_MODEL : DEFAULT_BEDROCK_MODEL);
  const region = process.env.AI_REGION || process.env.AWS_REGION || 'us-east-1';
  const api =
    provider === 'bedrock' ? (MANTLE_MODEL_RE.test(model) ? 'mantle' : 'invoke') : 'messages';
  return { enabled, provider, model, region, api };
}

export function isAiEnabled() {
  return aiConfig().enabled;
}

export function getAiClient() {
  if (override) return override;
  if (cached) return cached.client;
  const cfg = aiConfig();
  if (!cfg.enabled) {
    throw new Parse.Error(Parse.Error.SCRIPT_FAILED, 'AI features are disabled on this server.');
  }
  let client;
  if (cfg.provider === 'anthropic') {
    client = new Anthropic();
  } else if (cfg.api === 'mantle') {
    client = new AnthropicBedrockMantle({ awsRegion: cfg.region });
  } else {
    client = new AnthropicBedrock({ awsRegion: cfg.region });
  }
  cached = { client, model: cfg.model };
  return client;
}

export function aiModel() {
  return aiConfig().model;
}

/**
 * Turn a provider failure into something safe and actionable.
 *
 * Bedrock and the Anthropic API put the model ARN, the AWS account id and the
 * credential in their error text, and API/MCP callers are not the operator, so
 * the raw message is logged here and never returned. Parse.Errors raised by our
 * own code (a refusal, a malformed proposal) pass through untouched.
 */
export function providerError(err, what = 'analyse this document') {
  if (err instanceof Parse.Error) return err;
  const status = Number(err?.status) || 0;
  const raw = String(err?.message || err || '');
  console.log(`ai: provider call failed (status ${status || 'n/a'}):`, raw);
  const name = String(err?.name || err?.error?.type || '');
  const throttled = status === 429 || /throttl|too many requests|rate ?limit/i.test(raw + name);
  const denied =
    status === 401 ||
    status === 403 ||
    /accessdenied|unrecognizedclient|expiredtoken|invalidsignature|credential|not authorized|authentication/i.test(
      raw + name
    );
  if (denied) {
    return new Parse.Error(
      Parse.Error.SCRIPT_FAILED,
      'AI is not available on this server: the AI provider rejected the server credentials. Ask an administrator to check the AI configuration.'
    );
  }
  if (throttled) {
    return new Parse.Error(
      Parse.Error.SCRIPT_FAILED,
      'The AI service is busy right now. Please try again in a minute.'
    );
  }
  if (status === 400 || status === 413 || /too long|too large|exceeds/i.test(raw)) {
    return new Parse.Error(
      Parse.Error.VALIDATION_ERROR,
      `This document is too large or too complex for the AI to ${what}. Try a smaller PDF.`
    );
  }
  return new Parse.Error(
    Parse.Error.SCRIPT_FAILED,
    `The AI service could not ${what} right now. Please try again.`
  );
}

/** Public, non-secret description for the UI. */
export function describeAi() {
  const cfg = aiConfig();
  return {
    enabled: cfg.enabled,
    provider: cfg.provider,
    model: cfg.model,
    region: cfg.provider === 'bedrock' ? cfg.region : undefined,
  };
}
