/**
 * Coverage for the entry/config/infra fixes in this pass:
 *
 *  - `sanitizeFileName` must replace rather than delete, so a non-ASCII name
 *    does not reduce to '' before it reaches the file adapter.
 *  - `replaceMailVaribles` substitutes user data into outgoing HTML mail, so it
 *    must escape and must not honour `$` replacement patterns.
 *  - `generateId` mints the bulk-send token and a replacement password.
 *  - `getSecureUrl` must answer, not throw, when it is handed nothing.
 *  - the index migrations must follow the same database as the Parse config.
 *  - the sso auth adapter must be off unless SSO_API_URL was set on purpose.
 *  - docker-compose.yml must not publish Mongo on every interface, must pin its
 *    images and must not mount a volume over the baked-in mail templates.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  escapeHtml,
  generateId,
  getSecureUrl,
  replaceMailVaribles,
  sanitizeFileName,
} from '../Utils.js';
import { migrationDatabaseUri } from '../migrationdb/dbUri.js';
import { ssoEnabled } from '../auth/authadapter.js';
import { isCompletionRelevant } from '../utils/workflowUtils.js';

const REPO_ROOT = path.resolve(process.cwd(), '../..');

describe('sanitizeFileName', () => {
  it('keeps an ordinary name intact', () => {
    expect(sanitizeFileName('invoice-2026.pdf')).toBe('invoice-2026.pdf');
  });

  it('gives a fully non-ASCII name a stem instead of returning nothing', () => {
    const safe = sanitizeFileName('契約書.pdf');
    expect(safe).toBe('document.pdf');
    expect(safe.length).toBeGreaterThan(0);
  });

  it('replaces invalid characters rather than deleting them', () => {
    expect(sanitizeFileName('my file (1).pdf')).toContain('my-file');
    expect(sanitizeFileName('my file (1).pdf').endsWith('.pdf')).toBeTrue();
  });

  it('never leaves a path separator or a parent reference behind', () => {
    for (const name of ['../../etc/passwd', '..\\..\\win.ini', 'a/b/c.pdf']) {
      const safe = sanitizeFileName(name);
      expect(safe).not.toContain('/');
      expect(safe).not.toContain('\\');
      expect(safe).not.toContain('..');
    }
  });

  it('coerces a non-string instead of throwing', () => {
    expect(() => sanitizeFileName(undefined)).not.toThrow();
    expect(sanitizeFileName(undefined)).toBe('document');
    expect(sanitizeFileName(null)).toBe('document');
    expect(sanitizeFileName(42)).toBe('42');
  });
});

describe('replaceMailVaribles', () => {
  it('escapes markup in the body so a document name cannot inject html', () => {
    const { body } = replaceMailVaribles('', '<p>{{document_title}}</p>', {
      document_title: '<img src=x onerror=alert(1)>',
    });
    expect(body).not.toContain('<img');
    expect(body).toContain('&lt;img');
  });

  it('treats $ sequences in a value literally', () => {
    const { body, subject } = replaceMailVaribles('Sign {{name}}', '<p>{{name}}</p>', {
      name: 'A$&B$1',
    });
    expect(subject).toBe('Sign A$&B$1');
    expect(body).toBe('<p>A$&amp;B$1</p>');
  });

  it('leaves the subject unescaped: it is a plain text header', () => {
    const { subject } = replaceMailVaribles('{{title}}', '', { title: 'Terms & Conditions' });
    expect(subject).toBe('Terms & Conditions');
  });

  it('substitutes a missing value with an empty string rather than "undefined"', () => {
    const { body } = replaceMailVaribles('', '<p>[{{note}}]</p>', { note: undefined });
    expect(body).toBe('<p>[]</p>');
  });

  it('escapes the five characters that change the meaning of html', () => {
    expect(escapeHtml(`<&>"'`)).toBe('&lt;&amp;&gt;&quot;&#39;');
  });
});

describe('generateId', () => {
  it('returns the requested length from the expected alphabet', () => {
    const id = generateId(16);
    expect(id.length).toBe(16);
    expect(id).toMatch(/^[a-z0-9]{16}$/);
  });

  it('does not repeat itself across a batch', () => {
    const seen = new Set(Array.from({ length: 500 }, () => generateId(10)));
    expect(seen.size).toBe(500);
  });
});

describe('getSecureUrl', () => {
  it('answers { url: "" } instead of throwing when there is no url', () => {
    expect(getSecureUrl(undefined)).toEqual({ url: '' });
    expect(getSecureUrl('not a url')).toEqual({ url: '' });
  });

  it('passes a non-files url straight through', () => {
    const url = 'https://cdn.example.com/a/b.pdf';
    expect(getSecureUrl(url)).toEqual({ url });
  });
});

describe('migrationDatabaseUri', () => {
  const saved = { db: process.env.DATABASE_URI, mongo: process.env.MONGODB_URI };
  afterEach(() => {
    for (const [key, value] of [
      ['DATABASE_URI', saved.db],
      ['MONGODB_URI', saved.mongo],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('prefers DATABASE_URI, exactly as the Parse config does', () => {
    process.env.DATABASE_URI = 'mongodb://a/one';
    process.env.MONGODB_URI = 'mongodb://b/two';
    expect(migrationDatabaseUri()).toBe('mongodb://a/one');
  });

  it('falls back to MONGODB_URI', () => {
    delete process.env.DATABASE_URI;
    process.env.MONGODB_URI = 'mongodb://b/two';
    expect(migrationDatabaseUri()).toBe('mongodb://b/two');
  });

  it('falls back to the local dev database when neither is set', () => {
    delete process.env.DATABASE_URI;
    delete process.env.MONGODB_URI;
    expect(migrationDatabaseUri()).toBe('mongodb://localhost:27017/dev');
  });
});

describe('sso auth adapter', () => {
  it('is disabled unless SSO_API_URL names a provider', () => {
    // The specs never set SSO_API_URL, and there is deliberately no default:
    // the adapter mints a Parse session on the named host's say-so.
    expect(ssoEnabled).toBe(Boolean(process.env.SSO_API_URL));
  });
});

describe('isCompletionRelevant', () => {
  it('excludes prefill placeholders and roles nobody is bound to', () => {
    expect(isCompletionRelevant({ Role: 'prefill', signerObjId: 'a' })).toBeFalse();
    expect(isCompletionRelevant({ Role: 'Role 1', signerObjId: 'a' })).toBeTrue();
    expect(isCompletionRelevant({ Role: 'Role 1', signerPtr: { objectId: 'a' } })).toBeTrue();
    // Nobody can ever sign an unbound role, so counting it means the document
    // never completes.
    expect(isCompletionRelevant({ Role: 'Role 1' })).toBeFalse();
    expect(isCompletionRelevant({})).toBeFalse();
  });
});

/** The file with every comment line removed, so a comment quoting the old value
 * (which several of these deliberately do) cannot satisfy an assertion. */
function withoutComments(text) {
  return text
    .split('\n')
    .filter(line => !line.trim().startsWith('#'))
    .join('\n');
}

describe('docker-compose.yml', () => {
  const compose = withoutComments(
    fs.readFileSync(path.join(REPO_ROOT, 'docker-compose.yml'), 'utf8')
  );

  it('builds the one image from this checkout, not from the deploy host layout', () => {
    expect(compose).not.toContain('context: ./src');
    expect(compose).toContain('context: .');
    // The web app is built into the same image, not a second one.
    expect(compose).not.toContain('context: ./apps/web');
    expect(compose).toMatch(/^ {2}app:$/m);
  });

  it('pins the mongo and caddy images to a major version', () => {
    expect(compose).not.toContain('mongo:latest');
    expect(compose).not.toContain('caddy:latest');
    expect(compose).toMatch(/image: mongo:\d/);
    expect(compose).toMatch(/image: caddy:\d/);
  });

  it('never publishes mongo or the parse mount on every interface', () => {
    expect(compose).not.toMatch(/^\s+- "27018:27017"/m);
    expect(compose).not.toMatch(/^\s+- "8080:8080"/m);
    expect(compose).toContain('"127.0.0.1:27018:27017"');
    expect(compose).toContain('"127.0.0.1:8080:8080"');
  });

  it('mounts the uploads directory, not the one holding the mail templates', () => {
    expect(compose).toContain('docustamp-files:/usr/src/app/files/files');
    expect(compose).not.toMatch(/docustamp-files:\/usr\/src\/app\/files$/m);
  });
});

describe('Caddyfile', () => {
  const caddy = withoutComments(fs.readFileSync(path.join(REPO_ROOT, 'Caddyfile'), 'utf8'));

  it('proxies the whole site to the app, which serves /api itself', () => {
    expect(caddy).toContain('reverse_proxy app:8080');
    // Stripping /api here would break the app's own routing and file urls.
    expect(caddy).not.toContain('handle_path');
  });

  it('compresses responses', () => {
    expect(caddy).toMatch(/encode .*gzip/);
  });

  it('does not carry the no-op rewrite', () => {
    expect(caddy).not.toContain('rewrite * {uri}');
  });
});

describe('env templates', () => {
  // deploy/ only exists in private operator checkouts, so it is checked when present.
  const templates = ['.env.example', '.env.local_dev', 'deploy/lightsail/env.prod.example'].filter(
    file => fs.existsSync(path.join(REPO_ROOT, file))
  );
  for (const file of templates) {
    it(`${file} uses APP_NAME, the variable the code actually reads`, () => {
      const text = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
      expect(text).not.toMatch(/^appName=/m);
      expect(text).toMatch(/^APP_NAME=/m);
      expect(text).toMatch(/^GOOGLE_CLIENT_ID=/m);
    });
  }
});
