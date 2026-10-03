import { appName } from '../../Utils.js';
import { findSignatureIdFor, ownerAcl } from '../parsefunction/saveSignature.js';
import { conditionalUpdate } from './atomic.js';
import { API_URL_TTL, resolveFileUrl } from './files.js';
import { imageSize } from './stamp.js';
import { fetchStoredImage, isJpegBytes, storeSignatureImage } from './upload.js';

/**
 * The user's saved signature and initials (`contracts_Signature`, Settings >
 * My signature and initials), as an AI agent signing for them uses them.
 *
 * A person signing in the browser is offered the saved images
 * (`getdefaultsignature`, the adopt dialog's "Saved" tab). An agent takes them
 * without asking: the saved signature for signature fields, the saved initials
 * for initials fields. A user with none gets the typed one (their name in
 * Caveat, lib/stamp.js), and once it is signed that is saved for them the way
 * `savesignature` stores it, so from then on it is their signature everywhere
 * until they change it. An image already saved is never replaced.
 *
 * Read fresh every time: an approval decided later signs with what is saved
 * when it is decided.
 */

/** The column that holds each image (parsefunction/saveSignature.js). */
const COLUMNS = Object.freeze({ signature: 'ImageURL', initials: 'Initials' });
const KINDS = Object.keys(COLUMNS);

const DATA_IMAGE_RE = /^data:image\/[a-z+.-]+;base64,/i;

function userPointer(userId) {
  return { __type: 'Pointer', className: '_User', objectId: userId };
}

/** A stored image value worth using: a url or an image data url, else ''. */
function imageRef(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  return /^https?:\/\//i.test(raw) || DATA_IMAGE_RE.test(raw) ? raw : '';
}

/**
 * The user's saved images, newest row first (the one `getdefaultsignature`
 * answers). Urls as the afterFind trigger leaves them (signed for a few minutes).
 *
 * @param {string} userId `_User` objectId.
 * @returns {Promise<{id: string, signature: string, initials: string}>} '' for
 *   what is not saved.
 */
export async function readSavedSignature(userId) {
  if (!userId) return { id: '', signature: '', initials: '' };
  const query = new Parse.Query('contracts_Signature');
  query.equalTo('UserId', userPointer(userId));
  query.descending('updatedAt');
  const row = await query.first({ useMasterKey: true });
  return {
    id: row?.id || '',
    signature: imageRef(row?.get(COLUMNS.signature)),
    initials: imageRef(row?.get(COLUMNS.initials)),
  };
}

/** Bytes of a saved image, or null when it cannot be read. Never throws. */
async function savedImageBytes(ref) {
  if (DATA_IMAGE_RE.test(ref)) {
    const bytes = Buffer.from(ref.slice(ref.indexOf(',') + 1), 'base64');
    return bytes.length ? bytes : null;
  }
  return await fetchStoredImage(ref);
}

/**
 * The bytes of a saved image to stamp. Refuses, rather than stamping something
 * else, when it cannot be fetched or is not an image the stamp can draw.
 *
 * @param {string} ref a value from `readSavedSignature`.
 * @param {'signature'|'initials'} kind
 * @returns {Promise<Buffer>}
 */
export async function loadSavedImage(ref, kind) {
  const bytes = await savedImageBytes(ref);
  if (bytes) {
    try {
      await imageSize(bytes);
      return bytes;
    } catch (err) {
      console.log(`savedSignature: the saved ${kind} is not a readable image`, err?.message);
    }
  }
  throw new Parse.Error(
    Parse.Error.SCRIPT_FAILED,
    `Your saved ${kind} could not be loaded, so nothing was signed. Try again, or save it again in ${appName} Settings > My signature and initials.`
  );
}

/**
 * Short-lived links to the user's saved images, for showing what an agent will
 * stamp. Only stored urls get one (a data url is left out).
 *
 * @param {string} userId
 * @param {{ttl?: number}} [opts] link lifetime in seconds.
 * @returns {Promise<{signature?: string, initials?: string}>}
 */
export async function savedImageUrls(userId, { ttl = API_URL_TTL } = {}) {
  const saved = await readSavedSignature(userId);
  const out = {};
  for (const kind of KINDS) {
    if (!/^https?:\/\//i.test(saved[kind])) continue;
    try {
      // eslint-disable-next-line no-await-in-loop -- two at most
      out[kind] = await resolveFileUrl(saved[kind], { ttl });
    } catch (err) {
      console.log(`savedSignature: no link for the saved ${kind}`, err?.message);
    }
  }
  return out;
}

/**
 * The saved images a request will stamp, as data urls, for a page that loads
 * nothing from the network itself (the MCP app). What cannot be read is left out.
 *
 * @param {string} userId
 * @param {Iterable<string>} kinds 'signature' and/or 'initials'.
 * @returns {Promise<{signature?: string, initials?: string}>}
 */
export async function savedImageDataUrls(userId, kinds) {
  const wanted = new Set(kinds);
  const saved = await readSavedSignature(userId);
  const out = {};
  for (const kind of KINDS) {
    if (!wanted.has(kind) || !saved[kind]) continue;
    // eslint-disable-next-line no-await-in-loop -- two at most
    const bytes = await savedImageBytes(saved[kind]);
    if (!bytes) continue;
    out[kind] = `data:image/${isJpegBytes(bytes) ? 'jpeg' : 'png'};base64,${bytes.toString('base64')}`;
  }
  return out;
}

/**
 * Signature and initials values with `imageUrl` added where a saved image will
 * be stamped. Without one the name is set in Caveat, and the value stays text.
 *
 * @param {Object[]} values `{type, ...}` rows.
 * @param {{signature?: string, initials?: string}} urls from `savedImageUrls`.
 * @returns {Object[]}
 */
export function withSavedImages(values, urls) {
  return (values || []).map(v => {
    const imageUrl = KINDS.includes(v?.type) ? urls?.[v.type] : '';
    return imageUrl ? { ...v, imageUrl } : v;
  });
}

/** True when any of `values` is a signature or initials field. */
export function hasSignatureValues(values) {
  return (values || []).some(v => KINDS.includes(v?.type));
}

/**
 * Save typed images an agent signed with as the user's own, where the user has
 * none saved yet. Stored like the settings page stores them (an uploaded image
 * on the user's newest row, created with the owner-only ACL when there is
 * none). A column that holds an image by the time of the write is left alone:
 * the write only lands while it is still empty.
 *
 * Never throws: the document is signed by now, and a signature that could not
 * be saved is made again next time.
 *
 * @param {string} userId
 * @param {{signature?: Buffer, initials?: Buffer}} images PNG bytes.
 * @param {{name?: string}} [opts] `name` titles a new row, as the settings page does.
 * @returns {Promise<{signature: boolean, initials: boolean}>} what was saved.
 */
export async function saveTypedImages(userId, images, { name = '' } = {}) {
  const saved = { signature: false, initials: false };
  if (!userId) return saved;
  try {
    // Checked again right before storing anything, so a signature saved in the
    // meantime does not leave an unused upload behind.
    const current = await readSavedSignature(userId);
    const urls = {};
    for (const kind of KINDS) {
      if (!images?.[kind] || current[kind]) continue;
      // eslint-disable-next-line no-await-in-loop -- two at most
      const url = await storeSignatureImage(
        `data:image/png;base64,${Buffer.from(images[kind]).toString('base64')}`,
        { label: kind }
      );
      if (url) urls[kind] = url;
    }
    const kinds = Object.keys(urls);
    if (!kinds.length) return saved;
    const rowId = await findSignatureIdFor(userId);
    if (rowId) {
      for (const kind of kinds) {
        const column = COLUMNS[kind];
        // eslint-disable-next-line no-await-in-loop -- two at most
        saved[kind] = await conditionalUpdate(
          'contracts_Signature',
          rowId,
          { [column]: { $in: [null, ''] } },
          { [column]: urls[kind] }
        );
      }
      return saved;
    }
    const row = new Parse.Object('contracts_Signature');
    for (const kind of kinds) row.set(COLUMNS[kind], urls[kind]);
    if (String(name || '').trim()) row.set('SignatureName', String(name).trim());
    row.set('UserId', userPointer(userId));
    row.setACL(ownerAcl(userId));
    await row.save(null, { useMasterKey: true });
    for (const kind of kinds) saved[kind] = true;
  } catch (err) {
    console.log('savedSignature: the typed signature was not saved', err?.message || err);
  }
  return saved;
}
