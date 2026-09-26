import multer from 'multer';
import libre from 'libreoffice-convert';
import { exec } from 'child_process';
import { promisify } from 'util';
import { randomInt } from 'node:crypto';
import { getSecureUrl, supportEmail } from '../../Utils.js';
import { parseUploadFile } from '../../utils/fileUtils.js';
import { extUserForUser, resolveCaller } from '../parsefunction/authGuard.js';

const execAsync = promisify(exec);

// -------------------- Process Management --------------------

/**
 * How old (in seconds) a headless soffice process has to be before it counts as
 * stuck. It must exceed the longest conversion timeout below, so a conversion
 * that is merely slow is never killed.
 */
const STUCK_PROCESS_AGE_SECONDS = Number(process.env.DOCX2PDF_STUCK_AGE_SECONDS || 150);

/**
 * Kill headless LibreOffice processes older than STUCK_PROCESS_AGE_SECONDS.
 *
 * `libreoffice-convert` spawns soffice itself and does not hand back the child,
 * so there is no pid to target. What this must not do is what it used to:
 * `pkill -9 -f 'soffice.*--headless'` had no age predicate despite the comment
 * saying it did, and it is host-wide, so with DOCX2PDF_CONCURRENCY above 1 (or a
 * second container sharing the host) one slow conversion killed every other
 * conversion in flight. The age predicate keeps it to processes that have
 * outlived any conversion this server could still be waiting on.
 */
async function killStuckProcesses() {
  try {
    if (process.platform === 'linux' || process.platform === 'darwin') {
      const { stdout } = await execAsync('ps -eo pid=,etimes=,args=');
      const stuck = stdout
        .split('\n')
        .map(line => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
        .filter(match => match && /soffice/.test(match[3]) && /--headless/.test(match[3]))
        .filter(match => Number(match[2]) >= STUCK_PROCESS_AGE_SECONDS)
        .map(match => match[1]);
      if (!stuck.length) return;
      await execAsync(`kill -9 ${stuck.join(' ')} || true`);
      console.log(`[DOCX2PDF] Cleaned up ${stuck.length} stuck process(es): ${stuck.join(', ')}`);
    } else if (process.platform === 'win32') {
      // No portable age predicate here; wmic gives the creation time.
      await execAsync('taskkill /F /IM soffice.bin /T || exit 0');
      console.log('[DOCX2PDF] Cleaned up stuck processes (Windows)');
    }
  } catch (err) {
    console.error('[DOCX2PDF] Error killing processes:', err.message);
  }
}

/** @returns {Promise<Buffer>} */
async function convertLibre(input, ext, opts) {
  return await new Promise((resolve, reject) => {
    try {
      libre.convert(input, ext, opts, (err, out) => (err ? reject(err) : resolve(out)));
    } catch (e) {
      reject(e);
    }
  });
}

// -------------------- Concurrency limiter with queue limits --------------------
// One at a time by default: LibreOffice conversion is CPU bound.
const MAX_CONCURRENCY = Number(process.env.DOCX2PDF_CONCURRENCY || 1);
// Every queued request pins its (up to 50 MB) buffer in memory for as long as it
// waits, so the queue has to be bounded in both length and time. Without either,
// a burst grew the heap without limit and requests ran their conversion long
// after the client had given up. QUEUE_WAIT_MS should stay under the client and
// proxy timeouts so a rejection is what the caller actually sees.
const MAX_QUEUE = Number(process.env.DOCX2PDF_MAX_QUEUE || 10);
const QUEUE_WAIT_MS = Number(process.env.DOCX2PDF_QUEUE_WAIT_MS || 45000);

/** Thrown when the queue is full or a queued entry waited too long. */
export class ConversionBusyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConversionBusyError';
    this.status = 503;
  }
}

let active = 0;
const queue = [];

export function queueDepth() {
  return { active, queued: queue.length };
}

function runWithLimit(task) {
  return new Promise((resolve, reject) => {
    const run = async () => {
      active++;
      try {
        const result = await task();
        resolve(result);
      } catch (error) {
        reject(error);
      } finally {
        active--;
        while (queue.length) {
          const next = queue.shift();
          // Skip entries that already timed out while waiting.
          if (next.cancelled) continue;
          clearTimeout(next.timer);
          next.start();
          break;
        }
      }
    };
    if (active < MAX_CONCURRENCY) return run();
    if (queue.length >= MAX_QUEUE) {
      return reject(
        new ConversionBusyError('Document conversion is busy. Please try again in a moment.')
      );
    }
    const entry = { start: run, cancelled: false, timer: null };
    entry.timer = setTimeout(() => {
      entry.cancelled = true;
      // The buffer this request holds is released as soon as the handler's
      // promise rejects and its frame goes away.
      reject(
        new ConversionBusyError(`Document conversion queue wait exceeded ${QUEUE_WAIT_MS}ms.`)
      );
    }, QUEUE_WAIT_MS);
    entry.timer.unref?.();
    queue.push(entry);
  });
}

// -------------------- Timeout helper with cleanup --------------------
/**
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} [label='operation']
 * @returns {Promise<T>}
 */
export async function withTimeout(promise, ms, label = 'operation') {
  let timer;
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(async () => {
        // Kill stuck processes on timeout
        await killStuckProcesses();
        reject(new Error(`${label} timed out after ${ms}ms`));
      }, ms);
    });
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// -------------------- Multer: use memory storage --------------------
const storage = multer.memoryStorage();
export const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB hard limit at multer level
  fileFilter: (req, file, cb) => {
    const okExt = /\.docx$/i.test(file.originalname || '');
    const okMime =
      file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      file.mimetype === 'application/octet-stream';
    if (okExt && okMime) return cb(null, true);
    cb(new Error('Only .docx files are supported'));
  },
});

// The generated name is the object key the converted pdf is stored under, and
// the signed url is built from it, so it comes from the CSPRNG rather than the
// per-process Math.random sequence.
function generatePdfName(length) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) result += chars.charAt(randomInt(chars.length));
  return result;
}

export default async function docxtopdf(req, res) {
  if (!req.file || !req.file.buffer) {
    return res.status(400).json({ error: 'No file uploaded.' });
  }

  try {
    // The session and the profile row are resolved in process. This used to be
    // `axios.get(cloudServerUrl + '/users/me')` followed by a REST query on
    // `classes/contracts_Users` with the master key in a header: two HTTP round
    // trips the server made to itself, which fail whenever it cannot reach its
    // own public url, and which put the master key on the wire to do a lookup
    // `authGuard.extUserForUser` already does.
    const caller = await resolveCaller({ headers: req.headers });
    if (!caller) {
      return res.status(401).json({ error: 'User is not authenticated.' });
    }
    const extUser = await extUserForUser(caller, { include: ['TenantId'] });
    if (!extUser) {
      return res.status(403).json({ error: 'User not linked to tenant.' });
    }
    if (!extUser.get('TenantId')?.id) {
      return res.status(403).json({ error: 'Tenant not found for user.' });
    }

    const uploadedSizeBytes = req.file.size ?? req.file.buffer.length;
    const fileName = `${generatePdfName(16)}.pdf`;

    // ---- DOCX -> PDF conversion with concurrency control and timeout ----
    // Adjust timeout based on file size
    const timeoutMs = uploadedSizeBytes > 10 * 1024 * 1024 ? 120_000 : 90_000;

    // FIX: Increased timeout for large files, added nice priority
    const pdfBuffer = await runWithLimit(async () => {
      // Log for monitoring
      console.log(
        `[DOCX2PDF] Starting conversion, size: ${(uploadedSizeBytes / 1024 / 1024).toFixed(2)}MB, active: ${active}, queued: ${queue.length}`
      );

      const startTime = Date.now();
      try {
        const result = await withTimeout(
          convertLibre(req.file.buffer, '.pdf', undefined),
          timeoutMs,
          'DOCX->PDF'
        );
        console.log(`[DOCX2PDF] Completed in ${Date.now() - startTime}ms`);
        return result;
      } catch (error) {
        console.error(`[DOCX2PDF] Failed after ${Date.now() - startTime}ms:`, error.message);
        // Clean up on error
        await killStuckProcesses();
        throw error;
      }
    });

    // ---- Upload PDF ----
    // The `ActiveFileAdapter` branch posted to `/functions/savetofileadapter`,
    // a cloud function that is not defined in this build, so it answered 141 and
    // the caller got the generic "issues with processing DOCX files" message for
    // every tenant that had an adapter configured. Everything goes through the
    // one shared uploader.
    const stored = await parseUploadFile(fileName, Buffer.from(pdfBuffer), 'application/pdf');
    const fileUrl = getSecureUrl(stored?.url)?.url;
    if (!fileUrl) throw new Error('No URL returned from file storage');

    return res.status(200).json({ message: 'success.', url: fileUrl });
  } catch (err) {
    // `msg` can be an object (axios puts the parsed response body in
    // err.response.data), and calling .includes on it threw a TypeError inside
    // this catch, turning a handled conversion failure into an unhandled
    // rejection. Coerce first, then answer with the message that was derived
    // rather than throwing it away and always sending the generic one.
    const raw =
      err?.response?.data?.error || err?.response?.data || err?.message || 'Something went wrong.';
    const detail = typeof raw === 'string' ? raw : JSON.stringify(raw);
    const contact = supportEmail ? ` or contact ${supportEmail}` : '';
    const generic = `We could not convert this DOCX file. Please upload the PDF version${contact}.`;

    let status = 400;
    let code = 'conversion_failed';
    let message = generic;
    if (err instanceof ConversionBusyError) {
      status = 503;
      code = 'busy';
      message = 'The document converter is busy. Please try again in a moment.';
    } else if (detail.includes('timed out')) {
      code = 'timeout';
      message = `Document conversion is taking too long. Please try a smaller file${contact}.`;
    } else if (detail.includes('too large') || detail.includes('size')) {
      code = 'too_large';
      message = `File is too large to process. Please reduce the file size${contact}.`;
    }
    console.error(`[DOCX2PDF] Error (${code}): ${detail}`);
    if (status === 503) res.set('Retry-After', '30');
    return res.status(status).json({ error: message, code });
  }
}
