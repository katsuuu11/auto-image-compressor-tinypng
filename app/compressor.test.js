const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const sharp = require('sharp');
const { compressImage, setTinifyClientForTesting } = require('./compressor');

async function withTemporaryImage(ext, contents, callback) {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'image-compressor-'));
  const filePath = path.join(temporaryDirectory, `image${ext}`);

  try {
    await fs.writeFile(filePath, contents);
    return await callback(filePath);
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function createFakeTinify({ compressedBuffer, error, compressionCount = 42 }) {
  class AccountError extends Error {}
  class ConnectionError extends Error {}
  class ServerError extends Error {}
  class ClientError extends Error {}

  return {
    AccountError,
    ConnectionError,
    ServerError,
    ClientError,
    compressionCount,
    fromBuffer() {
      return {
        async toBuffer() {
          if (error) {
            throw error;
          }

          return compressedBuffer;
        },
      };
    },
  };
}

test.afterEach(() => {
  delete process.env.TINIFY_API_KEY;
  setTinifyClientForTesting(null);
});

test('compressImage uses tinify when TINIFY_API_KEY is set', async () => {
  process.env.TINIFY_API_KEY = 'test-key';
  const compressedBuffer = Buffer.from('small');
  const fakeTinify = createFakeTinify({ compressedBuffer, compressionCount: 42 });
  setTinifyClientForTesting(fakeTinify);

  const logs = [];
  const originalLog = console.log;
  console.log = (message) => logs.push(message);

  try {
    await withTemporaryImage('.png', Buffer.from('this image is intentionally larger'), async (filePath) => {
      const result = await compressImage(filePath);
      const writtenBuffer = await fs.readFile(filePath);

      assert.equal(result.success, true);
      assert.equal(result.skipped, false);
      assert.equal(result.originalSize, 34);
      assert.equal(result.compressedSize, compressedBuffer.length);
      assert.deepEqual(writtenBuffer, compressedBuffer);
    });
  } finally {
    console.log = originalLog;
  }

  assert.match(logs.join('\n'), /engine=tinify/);
  assert.match(logs.join('\n'), /compressionCount=42\/500/);
});

test('compressImage falls back to sharp for tinify account errors', async () => {
  process.env.TINIFY_API_KEY = 'test-key';
  const jpeg = await sharp({
    create: {
      width: 8,
      height: 8,
      channels: 3,
      background: { r: 255, g: 0, b: 0 },
    },
  })
    .jpeg({ quality: 100 })
    .toBuffer();
  const fakeTinify = createFakeTinify({ compressedBuffer: Buffer.from('unused') });
  const accountError = new fakeTinify.AccountError('monthly limit reached');
  fakeTinify.fromBuffer = () => ({
    async toBuffer() {
      throw accountError;
    },
  });
  setTinifyClientForTesting(fakeTinify);

  const logs = [];
  const warnings = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = (message) => logs.push(message);
  console.warn = (message) => warnings.push(message);

  try {
    await withTemporaryImage('.jpg', jpeg, async (filePath) => {
      const result = await compressImage(filePath);

      assert.equal(result.success, true);
    });
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }

  assert.match(warnings.join('\n'), /fallback=sharp/);
  assert.match(warnings.join('\n'), /monthly limit reached/);
  assert.match(logs.join('\n'), /engine=sharp/);
});

test('compressImage does not fall back for tinify client errors', async () => {
  process.env.TINIFY_API_KEY = 'test-key';
  const fakeTinify = createFakeTinify({ compressedBuffer: Buffer.from('unused') });
  const clientError = new fakeTinify.ClientError('bad image');
  fakeTinify.fromBuffer = () => ({
    async toBuffer() {
      throw clientError;
    },
  });
  setTinifyClientForTesting(fakeTinify);

  await withTemporaryImage('.png', Buffer.from('bad input'), async (filePath) => {
    const result = await compressImage(filePath);

    assert.equal(result.success, false);
    assert.match(result.error, /bad image/);
  });
});
