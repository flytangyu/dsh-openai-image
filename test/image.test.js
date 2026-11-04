import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, open, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { API_URL, apply, createImageTool } from '../index.js';

// A complete 1x1 PNG, rather than an arbitrary string with a PNG extension.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB1sAAAAASUVORK5CYII=', 'base64');
const DEFAULT_KEY = 'sk-unit-test-key-not-a-real-credential';

function imageResponse(count = 1) {
  return Response.json({ data: Array.from({ length: count }, () => ({ b64_json: PNG.toString('base64') })) });
}

async function harness(t, overrides = {}) {
  // macOS tmpdir can begin /var while realpath begins /private/var.
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'dsh-image-test-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outputDirectory = join(directory, 'images');
  let credential = { value: DEFAULT_KEY, source: 'file' };
  const credentialCalls = [];
  const ctx = {
    credentials: {
      async resolve(ref) {
        credentialCalls.push(ref);
        return credential;
      },
    },
  };
  const config = { outputDirectory, ...overrides };
  return {
    directory, outputDirectory, ctx, config, credentialCalls,
    tool: createImageTool(ctx, config),
    setCredential(value) { credential = value; },
    execute(args = { prompt: '一只坐在窗边的小猫' }, signal = new AbortController().signal) {
      return this.tool.execute(args, { signal });
    },
    mockFetch(fn) { return t.mock.method(globalThis, 'fetch', fn); },
  };
}

test('registers one usable tool with timeout and no caller-selected output path', async (t) => {
  const h = await harness(t);
  const registrations = [];
  const logLines = [];
  apply({ ...h.ctx, tools: { register: tool => registrations.push(tool) }, logger: { info: line => logLines.push(line) } }, h.config);
  assert.equal(registrations.length, 1);
  const tool = registrations[0];
  assert.equal(tool.name, 'generate_image');
  assert.equal(tool.timeoutMs, 600000);
  assert.equal(tool.isConcurrencySafe(), false);
  assert.equal(tool.parameters.additionalProperties, false);
  assert.deepEqual(tool.parameters.required, ['prompt']);
  for (const forbidden of ['api_key', 'apiKey', 'url', 'baseURL', 'outputDirectory', 'file_path', 'target']) {
    assert.equal(Object.hasOwn(tool.parameters.properties, forbidden), false);
  }
  assert.equal(h.credentialCalls.length, 0, 'registration must not fetch or cache the secret');
  assert.equal(logLines.join('\n').includes(DEFAULT_KEY), false);
});

test('posts the expected request and preserves PNG bytes in private local storage', async (t) => {
  const h = await harness(t);
  const originalFetch = globalThis.fetch;
  const fetchMock = h.mockFetch(async (url, options) => {
    assert.equal(url, API_URL);
    assert.equal(url, 'https://api.openai.com/v1/images/generations');
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, `Bearer ${DEFAULT_KEY}`);
    assert.equal(options.headers['Content-Type'], 'application/json');
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.signal.aborted, false);
    assert.deepEqual(JSON.parse(options.body), {
      model: 'gpt-image-2', prompt: '一只坐在窗边的小猫', n: 1,
      size: '1024x1024', quality: 'medium', output_format: 'png', background: 'auto',
    });
    return imageResponse();
  });
  assert.notEqual(globalThis.fetch, originalFetch);
  const result = await h.execute();
  assert.equal(fetchMock.mock.callCount(), 1);
  assert.deepEqual(h.credentialCalls, ['OPENAI_API_KEY']);
  assert.equal(result.model, 'gpt-image-2');
  assert.equal(result.images.length, 1);
  const image = result.images[0];
  assert.equal(dirname(image.file_path), h.outputDirectory);
  assert.match(image.file_path, /\.png$/);
  assert.equal(image.mime_type, 'image/png');
  assert.equal(image.bytes, PNG.length);
  assert.deepEqual(await readFile(image.file_path), PNG);
  if (process.platform !== 'win32') {
    assert.equal((await stat(h.outputDirectory)).mode & 0o777, 0o700);
    assert.equal((await stat(image.file_path)).mode & 0o777, 0o600);
  }
  const rendered = h.tool.output.render({}, result);
  assert.ok(rendered.every(block => block.type === 'text'), 'text-only chat models must not receive an unsupported image block');
  assert.equal(JSON.stringify({ result, rendered }).includes(DEFAULT_KEY), false);
  assert.equal(JSON.stringify({ result, rendered }).includes(PNG.toString('base64')), false);
});

test('repeated generations preserve existing files and resolve the current key for every call', async (t) => {
  const h = await harness(t);
  await mkdir(h.outputDirectory, { mode: 0o700 });
  const existing = join(h.outputDirectory, 'keep.png');
  await writeFile(existing, 'existing user content');
  const keys = [];
  h.mockFetch(async (_url, options) => {
    keys.push(options.headers.Authorization);
    return imageResponse();
  });
  const first = await h.execute();
  const rotated = 'sk-rotated-unit-test-credential';
  h.setCredential({ value: rotated, source: 'file' });
  const second = await h.execute();
  assert.deepEqual(keys, [`Bearer ${DEFAULT_KEY}`, `Bearer ${rotated}`]);
  assert.deepEqual(h.credentialCalls, ['OPENAI_API_KEY', 'OPENAI_API_KEY']);
  assert.notEqual(first.images[0].file_path, second.images[0].file_path);
  assert.equal(await readFile(existing, 'utf8'), 'existing user content');
  assert.deepEqual(await readFile(first.images[0].file_path), PNG);
  assert.deepEqual(await readFile(second.images[0].file_path), PNG);
  assert.equal((await readdir(h.outputDirectory)).length, 3);
});

test('honors configured credential reference and model plus per-request image options', async (t) => {
  const h = await harness(t, { apiKeyRef: 'DRAWING_OPENAI_KEY', model: 'gpt-image-1', size: '1024x1536', quality: 'low', timeoutMs: 300000 });
  h.mockFetch(async (_url, options) => {
    assert.deepEqual(JSON.parse(options.body), {
      model: 'gpt-image-1', prompt: '透明背景的鲸鱼', n: 4,
      size: '1536x1024', quality: 'high', output_format: 'png', background: 'transparent',
    });
    return imageResponse(4);
  });
  const result = await h.execute({ prompt: '透明背景的鲸鱼', n: 4, size: '1536x1024', quality: 'high', background: 'transparent' });
  assert.deepEqual(h.credentialCalls, ['DRAWING_OPENAI_KEY']);
  assert.equal(result.model, 'gpt-image-1');
  assert.equal(result.images.length, 4);
  assert.equal(new Set(result.images.map(image => image.file_path)).size, 4);
  assert.equal(h.tool.timeoutMs, 300000);
});

test('refuses a symlinked output root before any paid request', async (t) => {
  const h = await harness(t);
  const actual = join(h.directory, 'actual');
  await mkdir(actual);
  await symlink(actual, h.outputDirectory, 'dir');
  const fetchMock = h.mockFetch(async () => assert.fail('unsafe root must be rejected before fetch'));
  await assert.rejects(h.execute(), { code: 'UNSAFE_IMAGE_DIRECTORY' });
  assert.equal(fetchMock.mock.callCount(), 0);
  assert.deepEqual(await readdir(actual), []);
});

test('HTTP errors redact credentials, bound provider text, and never retry', async (t) => {
  const h = await harness(t);
  const upstreamSecret = 'sk-other-secret-from-upstream';
  const bearerSecret = 'opaque-unrelated-bearer-secret';
  const fetchMock = h.mockFetch(async () => Response.json({ error: {
    message: `bad key ${DEFAULT_KEY}; ${upstreamSecret}; Bearer ${bearerSecret}; ${'x'.repeat(3000)}`,
  } }, { status: 401 }));
  await assert.rejects(h.execute(), error => {
    assert.equal(error.code, 'IMAGE_HTTP_401');
    assert.match(error.message, /HTTP 401/);
    assert.match(error.message, /\[REDACTED\]/);
    for (const secret of [DEFAULT_KEY, upstreamSecret, bearerSecret]) assert.equal(error.message.includes(secret), false);
    assert.ok(error.message.length < 800);
    return true;
  });
  assert.equal(fetchMock.mock.callCount(), 1);
  assert.deepEqual(await readdir(h.outputDirectory), []);
});

test('transport errors redact their nested cause and never retry', async (t) => {
  const h = await harness(t);
  const fetchMock = h.mockFetch(async () => {
    throw new Error('fetch failed', { cause: new Error(`proxy rejected Bearer ${DEFAULT_KEY}`) });
  });
  await assert.rejects(h.execute(), error => {
    assert.equal(error.code, 'IMAGE_TRANSPORT');
    assert.equal(error.message.includes(DEFAULT_KEY), false);
    assert.match(error.message, /\[REDACTED\]/);
    return true;
  });
  assert.equal(fetchMock.mock.callCount(), 1);
  assert.deepEqual(await readdir(h.outputDirectory), []);
});

test('missing and blank credentials fail before network or filesystem side effects', async (t) => {
  for (const credential of [undefined, { value: '' }, { value: '  ' }]) {
    await t.test(`credential ${credential === undefined ? 'absent' : JSON.stringify(credential.value)}`, async (t) => {
      const h = await harness(t);
      h.setCredential(credential);
      const fetchMock = h.mockFetch(async () => assert.fail('missing key must never reach fetch'));
      await assert.rejects(h.execute(), { code: 'MISSING_CREDENTIAL' });
      assert.equal(fetchMock.mock.callCount(), 0);
      assert.deepEqual(await readdir(h.directory), []);
    });
  }
});

test('invalid images and malformed responses produce no image files', async (t) => {
  const cases = [
    ['invalid JSON', () => new Response('<html>bad gateway</html>'), {}],
    ['missing data', () => Response.json({}), {}],
    ['invalid base64', () => Response.json({ data: [{ b64_json: 'not!base64' }] }), {}],
    ['wrong image signature', () => Response.json({ data: [{ b64_json: Buffer.from('not an image').toString('base64') }] }), {}],
    ['wrong requested format', () => imageResponse(), { output_format: 'jpeg' }],
    ['wrong image count', () => imageResponse(2), {}],
    ['one invalid item rejects whole batch', () => Response.json({ data: [{ b64_json: PNG.toString('base64') }, { b64_json: 'bad!' }] }), { n: 2 }],
  ];
  for (const [label, response, args] of cases) {
    await t.test(label, async (t) => {
      const h = await harness(t);
      h.mockFetch(async () => response());
      await assert.rejects(h.execute({ prompt: 'draw a cat', ...args }), { code: 'INVALID_IMAGE_RESPONSE' });
      assert.deepEqual(await readdir(h.outputDirectory), []);
    });
  }
});

test('rejects transparent JPEG and out-of-range image counts before resolving credentials', async (t) => {
  const cases = [
    { background: 'transparent', output_format: 'jpeg' },
    ...[0, -1, 5, 1.5, '2'].map(n => ({ n })),
  ];
  for (const args of cases) {
    await t.test(JSON.stringify(args), async (t) => {
      const h = await harness(t);
      const fetchMock = h.mockFetch(async () => assert.fail('invalid argument must not reach fetch'));
      await assert.rejects(h.execute({ prompt: 'draw a cat', ...args }), { code: 'INVALID_IMAGE_ARGUMENT' });
      assert.equal(h.credentialCalls.length, 0);
      assert.equal(fetchMock.mock.callCount(), 0);
      assert.deepEqual(await readdir(h.directory), []);
    });
  }
});

test('a pre-aborted call cannot resolve a credential, create a directory, or start a request', async (t) => {
  const h = await harness(t);
  const controller = new AbortController();
  const reason = new Error('user cancelled before dispatch');
  controller.abort(reason);
  const fetchMock = h.mockFetch(async () => assert.fail('aborted request must not run'));
  await assert.rejects(h.execute({ prompt: 'draw a cat' }, controller.signal), error => error === reason);
  assert.equal(h.credentialCalls.length, 0);
  assert.equal(fetchMock.mock.callCount(), 0);
  assert.deepEqual(await readdir(h.directory), []);
});

test('cancellation during fetch propagates to the network and prevents saving or retries', async (t) => {
  const h = await harness(t);
  const controller = new AbortController();
  const reason = new Error('user cancelled while generating');
  let requestSignal;
  const fetchMock = h.mockFetch((_url, options) => new Promise((resolve, reject) => {
    requestSignal = options.signal;
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    queueMicrotask(() => controller.abort(reason));
  }));
  await assert.rejects(h.execute({ prompt: 'draw a cat' }, controller.signal), error => error === reason);
  assert.equal(requestSignal.aborted, true);
  assert.equal(fetchMock.mock.callCount(), 1);
  assert.deepEqual(await readdir(h.outputDirectory), []);
});

test('a partial second-image write rolls back the entire batch without deleting unrelated files', async (t) => {
  for (const failureKind of ['disk full', 'cancelled']) {
    await t.test(failureKind, async (t) => {
      const h = await harness(t);
      await mkdir(h.outputDirectory, { mode: 0o700 });
      const existing = join(h.outputDirectory, 'keep.png');
      const existingContent = Buffer.from('an unrelated existing file');
      await writeFile(existing, existingContent);

      // Mock only FileHandle.writeFile, retaining real exclusive creation,
      // partial writes, close, and unlink behavior for this regression.
      const probePath = join(h.directory, 'filehandle-probe');
      const probe = await open(probePath, 'wx');
      const handlePrototype = Object.getPrototypeOf(probe);
      const originalWriteFile = handlePrototype.writeFile;
      await probe.close();
      await rm(probePath);

      const controller = new AbortController();
      const reason = failureKind === 'disk full'
        ? Object.assign(new Error('simulated disk exhaustion'), { code: 'ENOSPC' })
        : new DOMException('cancelled during image storage', 'AbortError');
      const handles = [];
      let confirmedPartialBatch = false;
      t.mock.method(handlePrototype, 'writeFile', async function (bytes, options) {
        handles.push(this);
        if (handles.length === 1) return originalWriteFile.call(this, bytes, options);
        assert.equal(handles.length, 2);
        await originalWriteFile.call(this, bytes.subarray(0, 8), options);

        const generatedNames = (await readdir(h.outputDirectory)).filter(name => name !== 'keep.png');
        const sizes = await Promise.all(generatedNames.map(async name => (await stat(join(h.outputDirectory, name))).size));
        assert.deepEqual(sizes.sort((a, b) => a - b), [8, PNG.length]);
        confirmedPartialBatch = true;
        if (failureKind === 'cancelled') {
          controller.abort(reason);
          options.signal.throwIfAborted();
        }
        throw reason;
      });
      const fetchMock = h.mockFetch(async () => imageResponse(2));

      await assert.rejects(h.execute({ prompt: 'two cat illustrations', n: 2 }, controller.signal), error => error === reason);
      assert.equal(confirmedPartialBatch, true, 'the failure must occur after one complete and one partial file exist');
      assert.equal(fetchMock.mock.callCount(), 1);
      assert.equal(handles.length, 2);
      assert.ok(handles.every(handle => handle.fd === -1), 'both file handles must be closed before rejection');
      assert.deepEqual(await readdir(h.outputDirectory), ['keep.png']);
      assert.deepEqual(await readFile(existing), existingContent);
    });
  }
});
