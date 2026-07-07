const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');

const RETRY_DELAY_MS = 500;
const MAX_RETRIES = 3;
const TINIFY_MONTHLY_FREE_LIMIT = 500;

const SUPPORTED_FORMATS = new Set(['.jpg', '.jpeg', '.png']);
const SKIPPED_FORMATS = new Set(['.gif', '.svg', '.webp', '.pdf']);
const JPEG_MIN_BYTES = 1024 * 1024;
const DEFAULT_JPEG_QUALITY = 86;

let tinifyClient;
let tinifyExhaustedMonth = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getFormat(filePath) {
  return path.extname(filePath).toLowerCase();
}

function getReductionPercent(originalSize, compressedSize) {
  if (originalSize === 0) {
    return 0;
  }

  return Math.round((1 - compressedSize / originalSize) * 100);
}

function getTinifyCompressionCount(tinify) {
  return tinify.compressionCount ?? tinify.compression_count;
}

function getCurrentMonth() {
  return new Date().toISOString().slice(0, 7);
}

function isTinifyEnabled() {
  return process.env.TINIFY_ENABLED === '1' || process.env.COMPRESSION_MODE === 'strong';
}

function getJpegMinBytes() {
  const configuredMinBytes = Number(process.env.JPEG_MIN_BYTES);

  return Number.isFinite(configuredMinBytes) && configuredMinBytes >= 0
    ? configuredMinBytes
    : JPEG_MIN_BYTES;
}

function isJpegFormat(ext) {
  return ext === '.jpg' || ext === '.jpeg';
}

function isTinifyExhaustedForCurrentMonth() {
  const currentMonth = getCurrentMonth();

  if (tinifyExhaustedMonth && tinifyExhaustedMonth !== currentMonth) {
    tinifyExhaustedMonth = null;
  }

  return tinifyExhaustedMonth === currentMonth;
}

function getTinifyClient() {
  if (!tinifyClient) {
    tinifyClient = require('tinify');
  }

  return tinifyClient;
}

function initializeTinify(apiKey) {
  if (!apiKey) {
    return null;
  }

  const tinify = getTinifyClient();
  tinify.key = apiKey;
  return tinify;
}

function isTinifyFallbackError(error, tinify) {
  return (
    error instanceof tinify.AccountError ||
    error instanceof tinify.ConnectionError ||
    error instanceof tinify.ServerError
  );
}

function logCompressionResult({ engine, filePath, originalSize, compressedSize, tinify }) {
  const reduction = getReductionPercent(originalSize, compressedSize);
  const compressionCount = tinify ? getTinifyCompressionCount(tinify) : undefined;
  const tinifyCount = compressionCount === undefined
    ? ''
    : ` compressionCount=${compressionCount}/${TINIFY_MONTHLY_FREE_LIMIT}`;

  console.log(
    `[compressImage] engine=${engine} file=${filePath} originalSize=${originalSize} ` +
      `compressedSize=${compressedSize} reduction=${reduction}%${tinifyCount}`,
  );
}

function logTinifyFallback(error) {
  console.warn(
    `[WARN] [compressImage] engine=tinify fallback=sharp reason=${error.name || 'Error'} ` +
      `message=${error.message}`,
  );
}

function isTinifyMonthlyLimitError(error) {
  return error.status === 429 || error.statusCode === 429;
}

function logTinifyExhaustedSkip(filePath) {
  console.info(`[compressImage] engine=sharp reason=tinifyExhausted file=${filePath}`);
}

async function writeSharpCompressedBuffer(ext, inputBuffer) {
  switch (ext) {
    case '.jpg':
    case '.jpeg':
      return sharp(inputBuffer).jpeg({ quality: DEFAULT_JPEG_QUALITY }).toBuffer();
    case '.png':
      return sharp(inputBuffer)
        .png({ compressionLevel: 8, effort: 10 })
        .toBuffer();
    default:
      return null;
  }
}

async function writeTinifyCompressedBuffer(inputBuffer, filePath) {
  if (isTinifyExhaustedForCurrentMonth()) {
    logTinifyExhaustedSkip(filePath);
    return null;
  }

  if (!isTinifyEnabled()) {
    return null;
  }

  const tinify = initializeTinify(process.env.TINIFY_API_KEY);

  if (!tinify) {
    return null;
  }

  try {
    const compressedBuffer = await tinify.fromBuffer(inputBuffer).toBuffer();
    return { buffer: compressedBuffer, tinify };
  } catch (error) {
    if (isTinifyFallbackError(error, tinify)) {
      if (isTinifyMonthlyLimitError(error)) {
        tinifyExhaustedMonth = getCurrentMonth();
      }

      logTinifyFallback(error);
      return null;
    }

    throw error;
  }
}

async function writeCompressedBuffer(ext, inputBuffer, filePath) {
  const tinifyResult = await writeTinifyCompressedBuffer(inputBuffer, filePath);

  if (tinifyResult) {
    return {
      engine: 'tinify',
      buffer: tinifyResult.buffer,
      tinify: tinifyResult.tinify,
    };
  }

  const compressedBuffer = await writeSharpCompressedBuffer(ext, inputBuffer);
  return compressedBuffer
    ? { engine: 'sharp', buffer: compressedBuffer }
    : null;
}

async function compressImage(filePath) {
  const ext = getFormat(filePath);

  if (SKIPPED_FORMATS.has(ext) || !SUPPORTED_FORMATS.has(ext)) {
    return {
      success: true,
      skipped: true,
      reason: `Unsupported format: ${ext || 'unknown'}`,
      filePath,
    };
  }

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      await fs.access(filePath);

      const originalBuffer = await fs.readFile(filePath);

      if (isJpegFormat(ext) && originalBuffer.length < getJpegMinBytes()) {
        return {
          success: true,
          skipped: true,
          reason: `JPEG is below compression threshold (${getJpegMinBytes()} bytes).`,
          filePath,
        };
      }

      const compressedResult = await writeCompressedBuffer(ext, originalBuffer, filePath);

      if (!compressedResult) {
        return {
          success: true,
          skipped: true,
          reason: `Unsupported format: ${ext}`,
          filePath,
        };
      }

      const compressedBuffer = compressedResult.buffer;
      logCompressionResult({
        engine: compressedResult.engine,
        filePath,
        originalSize: originalBuffer.length,
        compressedSize: compressedBuffer.length,
        tinify: compressedResult.tinify,
      });

      if (compressedBuffer.length >= originalBuffer.length) {
        return {
          success: true,
          skipped: true,
          reason: 'Compressed file is not smaller than original. Kept original.',
          filePath,
        };
      }

      await fs.writeFile(filePath, compressedBuffer);

      return {
        success: true,
        skipped: false,
        filePath,
        originalSize: originalBuffer.length,
        compressedSize: compressedBuffer.length,
      };
    } catch (error) {
      if (error.code === 'ENOENT') {
        return { success: false, error: 'File does not exist', filePath };
      }

      const lockErrorCodes = new Set(['EBUSY', 'EPERM', 'EACCES']);
      const shouldRetry = lockErrorCodes.has(error.code) && attempt < MAX_RETRIES;

      if (shouldRetry) {
        await sleep(RETRY_DELAY_MS);
        continue;
      }

      return {
        success: false,
        error: error.message,
        filePath,
      };
    }
  }

  return {
    success: false,
    error: 'Failed after retries',
    filePath,
  };
}

function setTinifyClientForTesting(nextTinifyClient) {
  tinifyClient = nextTinifyClient;
}

function resetTinifyExhaustionForTesting() {
  tinifyExhaustedMonth = null;
}

module.exports = {
  compressImage,
  initializeTinify,
  resetTinifyExhaustionForTesting,
  setTinifyClientForTesting,
};
