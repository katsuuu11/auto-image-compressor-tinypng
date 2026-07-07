const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const iconv = require('iconv-lite');
const {
  compressImageWithDuplicateGuard,
  containsCompressibleImage,
  containsWebsiteLikeImagePath,
  decodeEntryPath,
  extractAndCompressZip,
  getDuplicateExtractSkip,
  getSafeExtractionPath,
  isValidUtf8,
  looksLikeMojibake,
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

test('decodeEntryPath keeps valid UTF-8 names even when the ZIP Unicode flag is missing', () => {
  const fileName = '請求書.xlsx';
  const pathBuffer = Buffer.from(fileName, 'utf8');
  const entry = {
    path: pathBuffer.toString('binary'),
    pathBuffer,
    isUnicode: false,
  };

  assert.equal(isValidUtf8(pathBuffer), true);
  assert.equal(decodeEntryPath(entry), fileName);
});

test('decodeEntryPath keeps CP932 names that happen to be valid UTF-8 byte sequences', () => {
  const fileName = 'ﾂｩ.xlsx';
  const pathBuffer = iconv.encode(fileName, 'cp932');
  const entry = {
    path: pathBuffer.toString('binary'),
    pathBuffer,
    isUnicode: false,
  };

  assert.equal(isValidUtf8(pathBuffer), true);
  assert.equal(looksLikeMojibake(iconv.decode(pathBuffer, 'cp932')), false);
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
      { entry: { type: 'File' }, entryPath: '資料/写真.PNG' },
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

test('getSafeExtractionPath rejects ZIP entries outside the extraction directory', () => {
  const zipDirectory = path.join('/tmp', 'image-compressor');

  assert.equal(
    getSafeExtractionPath(zipDirectory, 'safe/画像.png'),
    path.join(zipDirectory, 'safe', '画像.png'),
  );
  assert.equal(
    getSafeExtractionPath(zipDirectory, '..safe/画像.png'),
    path.join(zipDirectory, '..safe', '画像.png'),
  );
  assert.equal(getSafeExtractionPath(zipDirectory, '../outside.png'), null);
  assert.equal(getSafeExtractionPath(zipDirectory, '/tmp/outside.png'), null);
  assert.equal(getSafeExtractionPath(zipDirectory, 'C:/outside.png'), null);
});

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
  return createStoredZipFromEntries([{ fileNameBuffer, contents }]);
}

function createStoredZipFromEntries(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;

  for (const { fileNameBuffer, contents } of entries) {
    const checksum = crc32(contents);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(contents.length, 18);
    localHeader.writeUInt32LE(contents.length, 22);
    localHeader.writeUInt16LE(fileNameBuffer.length, 26);

    localParts.push(localHeader, fileNameBuffer, contents);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(contents.length, 20);
    centralHeader.writeUInt32LE(contents.length, 24);
    centralHeader.writeUInt16LE(fileNameBuffer.length, 28);
    centralHeader.writeUInt32LE(localOffset, 42);

    centralParts.push(centralHeader, fileNameBuffer);
    localOffset += localHeader.length + fileNameBuffer.length + contents.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const localDirectory = Buffer.concat(localParts);
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(entries.length, 8);
  endRecord.writeUInt16LE(entries.length, 10);
  endRecord.writeUInt32LE(centralDirectory.length, 12);
  endRecord.writeUInt32LE(localDirectory.length, 16);

  return Buffer.concat([localDirectory, centralDirectory, endRecord]);
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

test('extractAndCompressZip preserves UTF-8 non-image file names in mixed ZIPs', async () => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'image-compressor-'));
  const zipPath = path.join(temporaryDirectory, 'mixed.zip');
  const imageName = '日本語画像.png';
  const spreadsheetName = '請求書.xlsx';
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAFgAI/ScL3WQAAAABJRU5ErkJggg==',
    'base64',
  );

  try {
    await fs.writeFile(
      zipPath,
      createStoredZipFromEntries([
        { fileNameBuffer: iconv.encode(imageName, 'shift_jis'), contents: png },
        { fileNameBuffer: Buffer.from(spreadsheetName, 'utf8'), contents: Buffer.from('spreadsheet') },
      ]),
    );

    const result = await extractAndCompressZip(zipPath);

    assert.equal(result.skipped, false);
    assert.equal(result.compressedResults.length, 1);
    await fs.access(path.join(temporaryDirectory, imageName));
    await fs.access(path.join(temporaryDirectory, spreadsheetName));
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

test('extractAndCompressZip rejects unsafe ZIP entry paths', async () => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'image-compressor-'));
  const zipPath = path.join(temporaryDirectory, 'unsafe.zip');
  const outsidePath = path.join(temporaryDirectory, '..', 'outside.png');
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAFgAI/ScL3WQAAAABJRU5ErkJggg==',
    'base64',
  );

  try {
    await fs.writeFile(zipPath, createStoredZip(Buffer.from('../outside.png'), png));

    const result = await extractAndCompressZip(zipPath);

    assert.equal(result.success, false);
    assert.match(result.error, /Unsafe ZIP entry path/);
    await assert.rejects(fs.access(outsidePath), { code: 'ENOENT' });
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
    await fs.rm(outsidePath, { force: true });
  }
});

test('extractAndCompressZip rejects unsafe ZIP entry paths before writing any files', async () => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'image-compressor-'));
  const zipPath = path.join(temporaryDirectory, 'partially-unsafe.zip');
  const safePath = path.join(temporaryDirectory, 'safe.png');
  const outsidePath = path.join(temporaryDirectory, '..', 'outside.png');
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAFgAI/ScL3WQAAAABJRU5ErkJggg==',
    'base64',
  );

  try {
    await fs.writeFile(
      zipPath,
      createStoredZipFromEntries([
        { fileNameBuffer: Buffer.from('safe.png'), contents: png },
        { fileNameBuffer: Buffer.from('../outside.png'), contents: png },
      ]),
    );

    const result = await extractAndCompressZip(zipPath);

    assert.equal(result.success, false);
    assert.match(result.error, /Unsafe ZIP entry path/);
    await assert.rejects(fs.access(safePath), { code: 'ENOENT' });
    await assert.rejects(fs.access(outsidePath), { code: 'ENOENT' });
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
    await fs.rm(outsidePath, { force: true });
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

test('compressImageWithDuplicateGuard does not cooldown failed compression results', async () => {
  let calls = 0;
  setCompressImageForTesting(async (filePath) => {
    calls += 1;
    return calls === 1
      ? { success: false, error: 'temporary failure', filePath }
      : { success: true, skipped: false, filePath };
  });

  const firstResult = await compressImageWithDuplicateGuard('/tmp/retry.png', 'first');
  const secondResult = await compressImageWithDuplicateGuard('/tmp/retry.png', 'second');

  assert.equal(firstResult.success, false);
  assert.equal(secondResult.success, true);
  assert.equal(secondResult.skipped, false);
  assert.equal(calls, 2);
});


test('containsCompressibleImage excludes WebP from automatic compression targets', () => {
  assert.equal(
    containsCompressibleImage([{ entry: { type: 'File' }, entryPath: '資料/写真.webp' }]),
    false,
  );
});
