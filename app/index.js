require('dotenv/config');
const path = require('node:path');
const fs = require('node:fs/promises');
const fss = require('node:fs');
const express = require('express');
const cors = require('cors');
const unzipper = require('unzipper');
const iconv = require('iconv-lite');
const { compressImage, initializeTinify } = require('./compressor');

initializeTinify(process.env.TINIFY_API_KEY);

const PORT = 3000;
const app = express();
const IMAGE_PATH_PATTERNS = ['images/', 'image/', 'img/'];
const COMPRESSIBLE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const DEFAULT_DUPLICATE_COOLDOWN_MS = 5000;
const RECENT_COMPLETION_TTL_MS = 60 * 60 * 1000;
const RECENT_COMPLETION_CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
const RECENT_EXTRACT_TTL_MS = 5000;

const inProgressPaths = new Set();
const recentlyCompletedPaths = new Map();
const recentExtractPaths = new Map();
let compressImageHandler = compressImage;

function decodeEntryPath(entry) {
  const isUnicode = entry.isUnicode ?? entry.props?.flags?.isUnicode;
  const pathBuffer = entry.pathBuffer ?? entry.props?.pathBuffer;

  if (!isUnicode && pathBuffer) {
    return iconv.decode(pathBuffer, 'shift_jis');
  }

  return entry.path;
}

function hasWebsiteLikeImagePath(entryPath) {
  const normalizedPath = entryPath.replace(/\\/g, '/').toLowerCase();
  return IMAGE_PATH_PATTERNS.some((pattern) => normalizedPath.includes(pattern));
}

function containsWebsiteLikeImagePath(entries) {
  // Inspect all entries in advance. If any path looks like website assets, skip the whole ZIP.
  return entries.some(({ entryPath }) => hasWebsiteLikeImagePath(entryPath));
}

function containsCompressibleImage(entries) {
  return entries.some(
    ({ entry, entryPath }) =>
      entry.type !== 'Directory' && COMPRESSIBLE_EXTENSIONS.has(path.extname(entryPath).toLowerCase()),
  );
}

function getDuplicateCooldownMs() {
  const configuredCooldown = Number(process.env.COMPRESS_DUPLICATE_COOLDOWN_MS);

  return Number.isFinite(configuredCooldown) && configuredCooldown >= 0
    ? configuredCooldown
    : DEFAULT_DUPLICATE_COOLDOWN_MS;
}

function getTrackedPath(filePath) {
  return path.resolve(filePath);
}

function getDuplicateSkipResult({ filePath, source, reason }) {
  console.debug(`[compressImage] skipped reason=${reason} source=${source} path=${filePath}`);

  return {
    success: true,
    skipped: true,
    reason: `Duplicate compression skipped: ${reason}.`,
    filePath,
  };
}

function cleanupRecentlyCompletedPaths(now = Date.now()) {
  for (const [trackedPath, completedAt] of recentlyCompletedPaths.entries()) {
    if (now - completedAt > RECENT_COMPLETION_TTL_MS) {
      recentlyCompletedPaths.delete(trackedPath);
    }
  }
}

function getDuplicateCompressionSkip(filePath, source) {
  const trackedPath = getTrackedPath(filePath);

  if (inProgressPaths.has(trackedPath)) {
    return getDuplicateSkipResult({ filePath, source, reason: 'inProgress' });
  }

  const completedAt = recentlyCompletedPaths.get(trackedPath);
  if (completedAt === undefined) {
    return null;
  }

  const elapsedMs = Date.now() - completedAt;
  if (elapsedMs < getDuplicateCooldownMs()) {
    return getDuplicateSkipResult({ filePath, source, reason: 'cooldown' });
  }

  recentlyCompletedPaths.delete(trackedPath);
  return null;
}

async function compressImageWithDuplicateGuard(filePath, source = 'unknown') {
  const trackedPath = getTrackedPath(filePath);
  const duplicateSkip = getDuplicateCompressionSkip(filePath, source);

  if (duplicateSkip) {
    return duplicateSkip;
  }

  inProgressPaths.add(trackedPath);

  try {
    return await compressImageHandler(filePath);
  } finally {
    inProgressPaths.delete(trackedPath);
    recentlyCompletedPaths.set(trackedPath, Date.now());
  }
}

const cleanupRecentlyCompletedPathsInterval = setInterval(
  cleanupRecentlyCompletedPaths,
  RECENT_COMPLETION_CLEANUP_INTERVAL_MS,
);

if (typeof cleanupRecentlyCompletedPathsInterval.unref === 'function') {
  cleanupRecentlyCompletedPathsInterval.unref();
}

function getDuplicateExtractSkip(filePath, now = Date.now()) {
  const trackedPath = getTrackedPath(filePath);

  for (const [recentPath, receivedAt] of recentExtractPaths.entries()) {
    if (now - receivedAt > RECENT_EXTRACT_TTL_MS) {
      recentExtractPaths.delete(recentPath);
    }
  }

  const previousReceivedAt = recentExtractPaths.get(trackedPath);
  if (previousReceivedAt !== undefined && now - previousReceivedAt <= RECENT_EXTRACT_TTL_MS) {
    console.debug(`[/extract] skipped reason=duplicate path=${filePath}`);
    return {
      success: true,
      skipped: true,
      reason: 'Duplicate extract skipped.',
      filePath,
    };
  }

  recentExtractPaths.set(trackedPath, now);
  return null;
}

async function extractAndCompressZip(filePath) {
  const zipDirectory = path.dirname(filePath);
  const directory = await unzipper.Open.file(filePath);
  const entries = directory.files.map((entry) => ({
    entry,
    entryPath: decodeEntryPath(entry),
  }));

  if (containsWebsiteLikeImagePath(entries)) {
    return {
      success: true,
      skipped: true,
      reason: 'ZIP contains website-like image directory path (images/image/img).',
      filePath,
      extractedTo: zipDirectory,
    };
  }

  if (!containsCompressibleImage(entries)) {
    return {
      success: true,
      skipped: true,
      reason: 'ZIP does not contain compressible images (jpg/jpeg/png/webp).',
      filePath,
      extractedTo: zipDirectory,
    };
  }

  const compressedResults = [];

  for (const { entry, entryPath } of entries) {
    const destinationPath = path.join(zipDirectory, entryPath);

    if (entry.type === 'Directory') {
      await fs.mkdir(destinationPath, { recursive: true });
      continue;
    }

    await fs.mkdir(path.dirname(destinationPath), { recursive: true });

    await new Promise((resolve, reject) => {
      entry
        .stream()
        .pipe(fss.createWriteStream(destinationPath))
        .on('finish', resolve)
        .on('error', reject);
    });

    const ext = path.extname(destinationPath).toLowerCase();
    if (!COMPRESSIBLE_EXTENSIONS.has(ext)) {
      continue;
    }

    const result = await compressImageWithDuplicateGuard(destinationPath, 'zip');
    compressedResults.push(result);
  }

  return {
    success: true,
    skipped: false,
    filePath,
    extractedTo: zipDirectory,
    totalEntries: directory.files.length,
    compressedResults,
  };
}

app.use(express.json());
app.use(
  cors({
    origin(origin, callback) {
      if (!origin) {
        return callback(null, true);
      }
      if (origin.startsWith('chrome-extension://')) {
        return callback(null, true);
      }
      return callback(new Error('Not allowed by CORS'));
    },
  }),
);

app.post('/compress', async (req, res) => {
  const { filePath } = req.body || {};

  if (!filePath || typeof filePath !== 'string') {
    return res
      .status(400)
      .json({ success: false, error: 'filePath is required and must be a string' });
  }

  console.log(`[/compress] received path=${filePath}`);

  const result = await compressImageWithDuplicateGuard(filePath, '/compress');

  if (result.success) {
    return res.json({ success: true, filePath: result.filePath, ...result });
  }

  return res.status(500).json({ success: false, error: result.error, filePath });
});

app.post('/extract', async (req, res) => {
  const { filePath } = req.body || {};

  if (!filePath || typeof filePath !== 'string') {
    return res
      .status(400)
      .json({ success: false, error: 'filePath is required and must be a string' });
  }

  console.log(`[/extract] received path=${filePath}`);

  const duplicateSkip = getDuplicateExtractSkip(filePath);
  if (duplicateSkip) {
    return res.json(duplicateSkip);
  }

  try {
    const result = await extractAndCompressZip(filePath);
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message, filePath });
  }
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Image compressor app is running on http://localhost:${PORT}`);
  });
}

module.exports = {
  containsCompressibleImage,
  containsWebsiteLikeImagePath,
  decodeEntryPath,
  compressImageWithDuplicateGuard,
  cleanupRecentlyCompletedPaths,
  extractAndCompressZip,
  getDuplicateExtractSkip,
  setCompressImageForTesting(nextCompressImageHandler) {
    compressImageHandler = nextCompressImageHandler;
  },
  resetDuplicateCompressionStateForTesting() {
    inProgressPaths.clear();
    recentlyCompletedPaths.clear();
    recentExtractPaths.clear();
    compressImageHandler = compressImage;
  },
};
