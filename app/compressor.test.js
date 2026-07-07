const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const sharp = require('sharp');
const { OUTPUT_DIR_NAME, compressImage, resetTinifyExhaustionForTesting, setTinifyClientForTesting } = require('./compressor');

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
  delete process.env.TINIFY_ENABLED;
  delete process.env.COMPRESSION_MODE;
  delete process.env.JPEG_MIN_BYTES;
  resetTinifyExhaustionForTesting();
  setTinifyClientForTesting(null);
});

test('compressImage uses tinify when TINIFY_API_KEY is set', async () => {
  process.env.TINIFY_API_KEY = 'test-key';
  process.env.TINIFY_ENABLED = '1';
  const compressedBuffer = Buffer.from('small');
  const fakeTinify = createFakeTinify({ compressedBuffer, compressionCount: 42 });
  setTinifyClientForTesting(fakeTinify);

  const logs = [];
  const originalLog = console.log;
  console.log = (message) => logs.push(message);

  try {
    await withTemporaryImage('.png', Buffer.from('this image is intentionally larger'), async (filePath) => {
      const result = await compressImage(filePath);
      const outputFilePath = path.join(path.dirname(filePath), OUTPUT_DIR_NAME, path.basename(filePath));
      const originalBuffer = await fs.readFile(filePath);
      const writtenBuffer = await fs.readFile(outputFilePath);

      assert.equal(result.success, true);
      assert.equal(result.skipped, false);
      assert.equal(result.filePath, filePath);
      assert.equal(result.outputFilePath, outputFilePath);
      assert.equal(result.originalSize, 34);
      assert.equal(result.compressedSize, compressedBuffer.length);
      assert.deepEqual(originalBuffer, Buffer.from('this image is intentionally larger'));
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
  process.env.TINIFY_ENABLED = '1';
  process.env.JPEG_MIN_BYTES = '0';
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
  accountError.status = 429;
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

test('compressImage skips tinify for the rest of the month after a 429 account error', async () => {
  process.env.TINIFY_API_KEY = 'test-key';
  process.env.TINIFY_ENABLED = '1';
  process.env.JPEG_MIN_BYTES = '0';
  const jpeg = await sharp({
    create: {
      width: 8,
      height: 8,
      channels: 3,
      background: { r: 0, g: 255, b: 0 },
    },
  })
    .jpeg({ quality: 100 })
    .toBuffer();
  const fakeTinify = createFakeTinify({ compressedBuffer: Buffer.from('unused') });
  const accountError = new fakeTinify.AccountError('monthly limit reached');
  accountError.status = 429;
  let tinifyCalls = 0;
  fakeTinify.fromBuffer = () => {
    tinifyCalls += 1;
    return {
      async toBuffer() {
        throw accountError;
      },
    };
  };
  setTinifyClientForTesting(fakeTinify);

  const infos = [];
  const originalInfo = console.info;
  console.info = (message) => infos.push(message);

  try {
    await withTemporaryImage('.jpg', jpeg, async (filePath) => {
      const firstResult = await compressImage(filePath);
      const secondResult = await compressImage(filePath);

      assert.equal(firstResult.success, true);
      assert.equal(secondResult.success, true);
      assert.equal(tinifyCalls, 1);
    });
  } finally {
    console.info = originalInfo;
  }

  assert.match(infos.join('\n'), /reason=tinifyExhausted/);
});

test('compressImage does not fall back for tinify client errors', async () => {
  process.env.TINIFY_API_KEY = 'test-key';
  process.env.TINIFY_ENABLED = '1';
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


test('compressImage uses sharp for PNG by default even when a TinyPNG API key exists', async () => {
  process.env.TINIFY_API_KEY = 'test-key';
  const fakeTinify = createFakeTinify({ compressedBuffer: Buffer.from('tiny') });
  let tinifyCalls = 0;
  fakeTinify.fromBuffer = () => {
    tinifyCalls += 1;
    return {
      async toBuffer() {
        return Buffer.from('tiny');
      },
    };
  };
  setTinifyClientForTesting(fakeTinify);

  const png = await sharp({
    create: {
      width: 16,
      height: 16,
      channels: 4,
      background: { r: 0, g: 0, b: 255, alpha: 1 },
    },
  })
    .png({ compressionLevel: 0 })
    .toBuffer();

  await withTemporaryImage('.png', png, async (filePath) => {
    const result = await compressImage(filePath);

    assert.equal(result.success, true);
    assert.equal(tinifyCalls, 0);
  });
});

test('compressImage writes compressed images to a compressed folder without renaming the file', async () => {
  process.env.TINIFY_API_KEY = 'test-key';
  process.env.TINIFY_ENABLED = '1';
  const compressedBuffer = Buffer.from('tiny');
  const fakeTinify = createFakeTinify({ compressedBuffer });
  setTinifyClientForTesting(fakeTinify);

  await withTemporaryImage('.png', Buffer.from('large enough png placeholder'), async (filePath) => {
    const result = await compressImage(filePath);
    const expectedOutputPath = path.join(path.dirname(filePath), OUTPUT_DIR_NAME, path.basename(filePath));

    assert.equal(result.success, true);
    assert.equal(result.skipped, false);
    assert.equal(result.outputFilePath, expectedOutputPath);
    assert.deepEqual(await fs.readFile(filePath), Buffer.from('large enough png placeholder'));
    assert.deepEqual(await fs.readFile(expectedOutputPath), compressedBuffer);
  });
});

test('compressImage skips small JPEG files by default', async () => {
  const jpeg = await sharp({
    create: {
      width: 8,
      height: 8,
      channels: 3,
      background: { r: 255, g: 255, b: 0 },
    },
  })
    .jpeg({ quality: 100 })
    .toBuffer();

  await withTemporaryImage('.jpg', jpeg, async (filePath) => {
    const result = await compressImage(filePath);
    const writtenBuffer = await fs.readFile(filePath);

    assert.equal(result.success, true);
    assert.equal(result.skipped, true);
    assert.match(result.reason, /JPEG is below compression threshold/);
    assert.deepEqual(writtenBuffer, jpeg);
  });
});

test('compressImage skips WebP and PDF automatic compression targets', async () => {
  await withTemporaryImage('.webp', Buffer.from('webp'), async (filePath) => {
    const result = await compressImage(filePath);

    assert.equal(result.success, true);
    assert.equal(result.skipped, true);
    assert.match(result.reason, /Unsupported format: \.webp/);
  });

  await withTemporaryImage('.pdf', Buffer.from('%PDF'), async (filePath) => {
    const result = await compressImage(filePath);

    assert.equal(result.success, true);
    assert.equal(result.skipped, true);
    assert.match(result.reason, /Unsupported format: \.pdf/);
  });
});
