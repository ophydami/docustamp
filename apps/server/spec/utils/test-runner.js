import http from 'http';
import { ParseServer } from 'parse-server';
import { app, config } from '../../index.js';

export const dropDB = async () => {
  await Parse.User.logOut();
  return await Parse.Server.database.deleteEverything(true);
};
let parseServerState = {};

const DEFAULT_TEST_DB = 'parse-test';

/**
 * Where the specs keep their throw-away database.
 *
 * `dropDB()` wipes whatever this points at after every run, so it deliberately
 * ignores MONGODB_URI / DATABASE_URI: only MONGODB_TEST_URI moves it.
 *   - unset: a local mongod on the default port (`npm test`).
 *   - set:   e.g. the connection string `mongodb-runner start` prints on stdout
 *            (`npm run test:runner` feeds it in). That string carries no
 *            database name, so one is appended.
 */
export function testDatabaseUri() {
  const raw = process.env.MONGODB_TEST_URI?.trim();
  if (!raw) return `mongodb://localhost:27017/${DEFAULT_TEST_DB}`;
  const [base, query] = raw.split('?');
  const trimmed = base.replace(/\/+$/, '');
  const hasDbName = trimmed.replace(/^mongodb(\+srv)?:\/\//, '').includes('/');
  const uri = hasDbName ? trimmed : `${trimmed}/${DEFAULT_TEST_DB}`;
  return query ? `${uri}?${query}` : uri;
}

/**
 * Starts the ParseServer instance
 * @param {Object} parseServerOptions Used for creating the `ParseServer`
 * @return {Promise} Runner state
 */
export async function startParseServer() {
  delete config.databaseAdapter;
  const parseServerOptions = Object.assign(config, {
    databaseURI: testDatabaseUri(),
    masterKey: 'test',
    javascriptKey: 'test',
    appId: 'test',
    port: 30001,
    mountPath: '/test',
    serverURL: `http://localhost:30001/test`,
    logLevel: 'error',
    silent: true,
  });
  const parseServer = new ParseServer(parseServerOptions);
  await parseServer.start();
  app.use(parseServerOptions.mountPath, parseServer.app);
  const httpServer = http.createServer(app);
  await new Promise(resolve => httpServer.listen(parseServerOptions.port, resolve));
  Object.assign(parseServerState, {
    parseServer,
    httpServer,
    parseServerOptions,
  });
  return parseServerOptions;
}

/**
 * Stops the ParseServer instance
 * @return {Promise}
 */
export async function stopParseServer() {
  await new Promise(resolve => parseServerState.httpServer.close(resolve));
  parseServerState = {};
}
