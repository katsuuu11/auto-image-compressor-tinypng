const test = require('node:test');
const assert = require('node:assert/strict');
const iconv = require('iconv-lite');
const {
  compressImageWithDuplicateGuard,
  containsCompressibleImage,
  containsWebsiteLikeImagePath,
  decodeEntryPath,
  getDuplicateExtractSkip,
  resetDuplicateCompressionStateForTesting,
  setCompressImageForTesting,
} = require('./index');

test('decodeEntryPath decodes non-Unicode Shift-JIS file names as UTF-8 strings', () => {
  const fileName = '日本語画像.jpg';
  const entry = {
    path: iconv.encode(fileName, 'shift_jis').toString('utf8'),
    pathBuffer: iconv.encode(fileName, 'shift_jis'),
    isUnicode: false,
  };

  assert.equal(decodeEntryPath(entry), fileName);
});

test('decodeEntryPath keeps Unicode file names unchanged', () => {
  const entry = {
    path: '日本語画像.jpg',
    pathBuffer: Buffer.from('日本語画像.jpg'),
    isUnicode: true,
  };

  assert.equal(decodeEntryPath(entry), entry.path);
});

test('containsCompressibleImage detects supported images using decoded names', () => {
  assert.equal(
    containsCompressibleImage([
      { entry: { type: 'File' }, entryPath: '資料/readme.txt' },
      { entry: { type: 'File' }, entryPath: '資料/写真.WEBP' },
    ]),
    true,
  );
  assert.equal(
    containsCompressibleImage([{ entry: { type: 'File' }, entryPath: '資料/readme.txt' }]),
    false,
  );
});

test('containsWebsiteLikeImagePath checks decoded paths', () => {
  assert.equal(
    containsWebsiteLikeImagePath([{ entryPath: 'サイト/images/写真.jpg' }]),
    true,
  );
  assert.equal(containsWebsiteLikeImagePath([{ entryPath: '写真.jpg' }]), false);
});

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const { extractAndCompressZip } = require('./index');

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return crc >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createStoredZip(fileNameBuffer, contents) {
  const checksum = crc32(contents);
  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt32LE(checksum, 14);
  localHeader.writeUInt32LE(contents.length, 18);
  localHeader.writeUInt32LE(contents.length, 22);
  localHeader.writeUInt16LE(fileNameBuffer.length, 26);

  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(0x02014b50, 0);
  centralHeader.writeUInt16LE(20, 4);
  centralHeader.writeUInt16LE(20, 6);
  centralHeader.writeUInt32LE(checksum, 16);
  centralHeader.writeUInt32LE(contents.length, 20);
  centralHeader.writeUInt32LE(contents.length, 24);
  centralHeader.writeUInt16LE(fileNameBuffer.length, 28);

  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(1, 8);
  endRecord.writeUInt16LE(1, 10);
  endRecord.writeUInt32LE(centralHeader.length + fileNameBuffer.length, 12);
  endRecord.writeUInt32LE(localHeader.length + fileNameBuffer.length + contents.length, 16);

  return Buffer.concat([
    localHeader,
    fileNameBuffer,
    contents,
    centralHeader,
    fileNameBuffer,
    endRecord,
  ]);
}

test('extractAndCompressZip extracts Shift-JIS image names with readable Japanese characters', async () => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'image-compressor-'));
  const zipPath = path.join(temporaryDirectory, 'images.zip');
  const imageName = '日本語画像.png';
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAFgAI/ScL3WQAAAABJRU5ErkJggg==',
    'base64',
  );

  try {
    await fs.writeFile(zipPath, createStoredZip(iconv.encode(imageName, 'shift_jis'), png));

    const result = await extractAndCompressZip(zipPath);

    assert.equal(result.skipped, false);
    assert.equal(result.compressedResults.length, 1);
    await fs.access(path.join(temporaryDirectory, imageName));
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('extractAndCompressZip skips extraction when a ZIP contains no supported images', async () => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'image-compressor-'));
  const zipPath = path.join(temporaryDirectory, 'documents.zip');
  const textName = '説明.txt';

  try {
    await fs.writeFile(
      zipPath,
      createStoredZip(iconv.encode(textName, 'shift_jis'), Buffer.from('read me')),
    );

    const result = await extractAndCompressZip(zipPath);

    assert.equal(result.skipped, true);
    assert.match(result.reason, /does not contain compressible images/);
    await assert.rejects(fs.access(path.join(temporaryDirectory, textName)), { code: 'ENOENT' });
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test.afterEach(() => {
  delete process.env.COMPRESS_DUPLICATE_COOLDOWN_MS;
  resetDuplicateCompressionStateForTesting();
});

test('getDuplicateExtractSkip skips the same ZIP path within the duplicate window', () => {
  const debugLogs = [];
  const originalDebug = console.debug;
  console.debug = (message) => debugLogs.push(message);

  try {
    assert.equal(getDuplicateExtractSkip('/tmp/archive.zip', 1000), null);
    const duplicateResult = getDuplicateExtractSkip('/tmp/archive.zip', 5999);
    assert.equal(duplicateResult.success, true);
    assert.equal(duplicateResult.skipped, true);
    assert.match(duplicateResult.reason, /Duplicate extract/);
    assert.equal(getDuplicateExtractSkip('/tmp/archive.zip', 7001), null);
  } finally {
    console.debug = originalDebug;
  }

  assert.match(debugLogs.join('\n'), /reason=duplicate/);
});

test('compressImageWithDuplicateGuard skips duplicate requests while a file is in progress', async () => {
  let calls = 0;
  let resolveCompression;
  const compressionStarted = new Promise((resolve) => {
    setCompressImageForTesting(async (filePath) => {
      calls += 1;
      resolve();
      await new Promise((innerResolve) => {
        resolveCompression = innerResolve;
      });

      return { success: true, skipped: false, filePath };
    });
  });

  const debugLogs = [];
  const originalDebug = console.debug;
  console.debug = (message) => debugLogs.push(message);

  try {
    const firstResult = compressImageWithDuplicateGuard('/tmp/duplicate.png', 'first');
    await compressionStarted;

    const duplicateResult = await compressImageWithDuplicateGuard('/tmp/duplicate.png', 'second');
    resolveCompression();

    assert.equal((await firstResult).success, true);
    assert.equal(duplicateResult.success, true);
    assert.equal(duplicateResult.skipped, true);
    assert.match(duplicateResult.reason, /inProgress/);
    assert.equal(calls, 1);
  } finally {
    console.debug = originalDebug;
  }

  assert.match(debugLogs.join('\n'), /reason=inProgress/);
  assert.match(debugLogs.join('\n'), /source=second/);
});

test('compressImageWithDuplicateGuard skips completed paths during cooldown only', async () => {
  process.env.COMPRESS_DUPLICATE_COOLDOWN_MS = '20';
  let calls = 0;
  setCompressImageForTesting(async (filePath) => {
    calls += 1;
    return { success: true, skipped: false, filePath };
  });

  const debugLogs = [];
  const originalDebug = console.debug;
  console.debug = (message) => debugLogs.push(message);

  try {
    const firstResult = await compressImageWithDuplicateGuard('/tmp/cooldown.png', 'first');
    const cooldownResult = await compressImageWithDuplicateGuard('/tmp/cooldown.png', 'second');
    await new Promise((resolve) => setTimeout(resolve, 25));
    const afterCooldownResult = await compressImageWithDuplicateGuard('/tmp/cooldown.png', 'third');

    assert.equal(firstResult.skipped, false);
    assert.equal(cooldownResult.success, true);
    assert.equal(cooldownResult.skipped, true);
    assert.match(cooldownResult.reason, /cooldown/);
    assert.equal(afterCooldownResult.skipped, false);
    assert.equal(calls, 2);
  } finally {
    console.debug = originalDebug;
  }

  assert.match(debugLogs.join('\n'), /reason=cooldown/);
  assert.match(debugLogs.join('\n'), /source=second/);
});
