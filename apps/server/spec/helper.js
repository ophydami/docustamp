// Must stay first: it sets the env defaults that test-runner.js (and through it
// index.js) read while they are being imported. See spec/support/env.js.
import './support/env.js';
import { startParseServer, stopParseServer, dropDB } from './utils/test-runner.js';
beforeAll(
  async () => {
    await startParseServer();
    // Also drop before the run, not only after it. A run that never reached the
    // afterAll (a crash, a Ctrl-C, a CI timeout) used to leave its fixtures
    // behind, and the next run then failed in a beforeAll with 'Account already
    // exists' naming nothing real.
    await dropDB();
  },
  100 * 60 * 2
);

afterAll(async () => {
  await dropDB();
  await stopParseServer();
});
