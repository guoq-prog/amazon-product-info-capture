const BATCH_KEY = 'amazon-review-capture-extension-batch-v1';
const STORAGE_KEY = 'amazon-review-capture-extension-records-v1';
const HISTORY_KEY = 'amazon-review-capture-extension-history-v1';
const SITES = new Set(['amazon.de', 'amazon.com', 'amazon.co.uk', 'amazon.fr', 'amazon.it', 'amazon.es', 'amazon.nl', 'amazon.pl', 'amazon.se', 'amazon.ca', 'amazon.com.au', 'amazon.co.jp']);

function amazonUrl(asin, site) {
  const host = String(site || 'amazon.de').startsWith('amazon.') ? site : `amazon.${site}`;
  return `https://www.${host}/dp/${asin}`;
}

function isAmazonSite(url) {
  try { return SITES.has(new URL(url).hostname.replace(/^www\./, '')); } catch (_) { return false; }
}

async function recordExternalError(tabId, url) {
  const data = await chrome.storage.local.get({ [BATCH_KEY]: null, [STORAGE_KEY]: [], [HISTORY_KEY]: [] });
  const queue = data[BATCH_KEY];
  if (!queue?.active || queue.tabId !== tabId || queue.navigating) return;
  const asin = queue.items?.[queue.index];
  if (!asin) return;
  const record = { asin, marketplace: queue.marketplace || 'amazon.de', batchStatus: 'error', errorReason: '跳转到非 Amazon 页面', url: url || '', capturedAt: new Date().toISOString() };
  const records = Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY] : [];
  const history = Array.isArray(data[HISTORY_KEY]) ? data[HISTORY_KEY] : [];
  const index = records.findIndex(item => item.asin === asin && item.marketplace === record.marketplace);
  if (index >= 0) records[index] = { ...records[index], ...record }; else records.push(record);
  history.push(record);
  queue.index += 1;
  if (queue.index >= queue.items.length) queue.active = false;
  queue.navigating = true;
  await chrome.storage.local.set({ [BATCH_KEY]: queue, [STORAGE_KEY]: records, [HISTORY_KEY]: history });
  if (queue.active) await chrome.tabs.update(tabId, { url: amazonUrl(queue.items[queue.index], queue.marketplace) });
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== 'batch-register' || !sender.tab?.id) return;
  chrome.storage.local.get({ [BATCH_KEY]: null }).then(data => {
    const queue = data[BATCH_KEY];
    if (queue?.active && (!queue.tabId || queue.tabId === sender.tab.id)) {
      queue.tabId = sender.tab.id;
      queue.navigating = false;
      return chrome.storage.local.set({ [BATCH_KEY]: queue });
    }
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'loading' || isAmazonSite(tab.url)) return;
  recordExternalError(tabId, tab.url).catch(() => {});
});
