import axios from 'axios';

// Smoke checks for the server itself. Feature behaviour lives in the other specs.
describe('Server smoke', () => {
  Parse.User.enableUnsafeCurrentUser();

  it('answers checkadminexist without a session', async () => {
    const result = await Parse.Cloud.run('checkadminexist');
    expect(['exist', 'not_exist']).toContain(result);
  });

  it('serves the root page', async () => {
    // `status < 500` also passed for a 404 and for a blank 200, which is the
    // failure this is meant to catch: the root route not being mounted at all.
    const { status, data } = await axios.get('http://localhost:30001/', {
      validateStatus: () => true,
    });
    expect(status).toBe(200);
    expect(String(data)).toContain('docustamp-server is running');
  });

  it('refuses an unsigned /files/ read, by GET and by HEAD alike', async () => {
    for (const method of ['get', 'head']) {
      const res = await axios.request({
        method,
        url: 'http://localhost:30001/test/files/test/nothing.pdf',
        validateStatus: () => true,
      });
      expect(res.status).withContext(method).toBe(400);
    }
  });
});
