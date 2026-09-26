/**
 * Settings filled in from the hosting platform (cloud/lib/platformEnv.js), so a
 * one-click deploy on Railway, Render or Fly.io needs almost no typing.
 */
import { platformDefaults, platformOrigin, withDatabase } from '../cloud/lib/platformEnv.js';

describe('platformOrigin', () => {
  it('reads each platform the way it publishes its address', () => {
    expect(platformOrigin({ RAILWAY_PUBLIC_DOMAIN: 'docustamp-production.up.railway.app' })).toBe(
      'https://docustamp-production.up.railway.app'
    );
    expect(platformOrigin({ RENDER_EXTERNAL_URL: 'https://docustamp.onrender.com/' })).toBe(
      'https://docustamp.onrender.com'
    );
    expect(platformOrigin({ FLY_APP_NAME: 'docustamp' })).toBe('https://docustamp.fly.dev');
    expect(platformOrigin({})).toBe('');
  });
});

describe('platformDefaults', () => {
  it('fills PUBLIC_URL and SERVER_URL from the platform address', () => {
    expect(platformDefaults({ RAILWAY_PUBLIC_DOMAIN: 'ds.up.railway.app' })).toEqual({
      PUBLIC_URL: 'https://ds.up.railway.app',
      SERVER_URL: 'https://ds.up.railway.app/api/app',
    });
  });

  it('never overrides what was set, and builds SERVER_URL from a custom domain', () => {
    const defaults = platformDefaults({
      RAILWAY_PUBLIC_DOMAIN: 'ds.up.railway.app',
      PUBLIC_URL: 'https://sign.example.com/',
    });
    expect(defaults).toEqual({ SERVER_URL: 'https://sign.example.com/api/app' });
    expect(
      platformDefaults({
        PUBLIC_URL: 'https://sign.example.com',
        SERVER_URL: 'https://api.example.com/app',
      })
    ).toEqual({});
  });

  it('follows a custom Parse mount', () => {
    expect(platformDefaults({ FLY_APP_NAME: 'ds', PARSE_MOUNT: '/parse' }).SERVER_URL).toBe(
      'https://ds.fly.dev/api/parse'
    );
  });

  it("uses Railway's MongoDB only when no database is configured", () => {
    const mongo = 'mongodb://mongo:secret@mongodb.railway.internal:27017';
    expect(platformDefaults({ MONGO_URL: mongo }).MONGODB_URI).toBe(
      'mongodb://mongo:secret@mongodb.railway.internal:27017/docustamp?authSource=admin'
    );
    expect(platformDefaults({ MONGO_URL: mongo, MONGODB_URI: 'mongodb://db/x' })).toEqual({});
    expect(platformDefaults({ MONGO_URL: mongo, DATABASE_URI: 'mongodb://db/x' })).toEqual({});
  });

  it('fills nothing outside a platform', () => {
    expect(platformDefaults({})).toEqual({});
  });
});

describe('withDatabase', () => {
  it('keeps a connection string that already names a database', () => {
    expect(withDatabase('mongodb://u:p@h:27017/prod?retryWrites=true')).toBe(
      'mongodb://u:p@h:27017/prod?retryWrites=true'
    );
  });

  it('adds the database, and the admin auth source only for credentials', () => {
    expect(withDatabase('mongodb://h:27017/')).toBe('mongodb://h:27017/docustamp');
    expect(withDatabase('mongodb+srv://u:p@cluster.example.net/?retryWrites=true')).toBe(
      'mongodb+srv://u:p@cluster.example.net/docustamp?retryWrites=true&authSource=admin'
    );
    expect(withDatabase('mongodb://u:p@h:27017/?authSource=other')).toBe(
      'mongodb://u:p@h:27017/docustamp?authSource=other'
    );
  });
});
