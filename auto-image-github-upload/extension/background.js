const TARGET_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.zip']);
const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;

const processedDownloadIds = new Set();
const pollingTargets = new Map();

function getExtension(filePath) {
  const match = filePath.toLowerCase().match(/\.[^./\\]+$/);
  return match ? match[0] : '';
}

function processDownload(filePath, ext) {
  const endpoint = ext === '.zip' ? '/extract' : '/compress';

  return fetch(`http://localhost:3000${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ filePath }),
  })
    .then((response) => response.json())
    .then((data) => {
      console.log('[Image Auto Compressor] Processing result:', data);
    });
}

function shouldTrackDownload(downloadItem) {
  if (!downloadItem || !downloadItem.id || !downloadItem.filename) {
    return false;
  }

  const ext = getExtension(downloadItem.filename);
  return TARGET_EXTENSIONS.has(ext);
}

function handleDownloadItem(downloadItem) {
  if (!downloadItem || !downloadItem.id || !downloadItem.filename) {
    return;
  }

  if (processedDownloadIds.has(downloadItem.id)) {
    return;
  }

  const ext = getExtension(downloadItem.filename);
  if (!TARGET_EXTENSIONS.has(ext)) {
    return;
  }

  processedDownloadIds.add(downloadItem.id);

  processDownload(downloadItem.filename, ext).catch((error) => {
    console.error('[Image Auto Compressor] Compression request failed:', error);
    processedDownloadIds.delete(downloadItem.id);
  });
}

function stopPolling(id) {
  pollingTargets.delete(id);
}

function startPolling(id) {
  if (!id || pollingTargets.has(id) || processedDownloadIds.has(id)) {
    return;
  }

  pollingTargets.set(id, Date.now());
}

setInterval(() => {
  if (pollingTargets.size === 0) {
    return;
  }

  const now = Date.now();

  for (const [id, startedAt] of pollingTargets.entries()) {
    if (now - startedAt > POLL_TIMEOUT_MS) {
      console.warn('[Image Auto Compressor] Polling timed out:', id);
      stopPolling(id);
      continue;
    }

    chrome.downloads.search({ id }, (results) => {
      if (!results || results.length === 0) {
        return;
      }

      const item = results[0];

      if (item.state === 'complete') {
        handleDownloadItem(item);
        stopPolling(id);
        return;
      }

      if (item.state === 'interrupted') {
        stopPolling(id);
      }
    });
  }
}, POLL_INTERVAL_MS);

chrome.downloads.onCreated.addListener((downloadItem) => {
  if (!shouldTrackDownload(downloadItem)) {
    return;
  }

  startPolling(downloadItem.id);
});

chrome.downloads.onChanged.addListener((delta) => {
  if (!delta.id) {
    return;
  }

  if (delta.state && delta.state.current === 'complete') {
    chrome.downloads.search({ id: delta.id }, (results) => {
      if (!results || results.length === 0) {
        console.log('[Image Auto Compressor] Download item not found:', delta.id);
        return;
      }

      handleDownloadItem(results[0]);
    });

    stopPolling(delta.id);
    return;
  }

  if (delta.state && delta.state.current === 'interrupted') {
    stopPolling(delta.id);
  }
});
