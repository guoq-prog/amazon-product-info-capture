(() => {
  'use strict';

  const VERSION = '1.4.10';
  const UPDATE_URL = 'https://raw.githubusercontent.com/guoq-prog/amazon-product-info-capture/main/version.json';
  // 由 alipay.jpg 以 Python 灰度阈值提取的 41×41 二维码模块；不再依赖外部 JPG。
  const ALIPAY_QR_HEX = 'fed6ad733fc168ad3a506e898a734bb753c9afa5dbaeba7302ec1411d9cd07faaaaaaafe00ca947f00121da6e89dde7c61b55b88e92219c59f22d37b4364e40baf5a4f8a0ce8f501ba156a0496b8f3982d6006a0b26c9094c700561acbada021126633900532ba7e900057a9a30400275e88cc013c147266010070fa0c7a4fe33205ef108226ed5d21b0208b7d929f3f38a6c86610611b30dea619226f601a6119854c909e2ba952fa807e6047c47f948ad2ab504c795f514ba4e8fe2f85d6822f534ae9c044843304f0deab6afe579b25db0';
  const STORAGE_KEY = 'amazon-review-capture-extension-records-v1';
  const HISTORY_KEY = 'amazon-review-capture-extension-history-v1';
  const SETTINGS_KEY = 'amazon-review-capture-extension-settings-v1';
  const BATCH_KEY = 'amazon-review-capture-extension-batch-v1';
  const PANEL_ID = 'amazon-review-capture-extension-panel';
  const exportFields = [
    ['asin', 'ASIN'], ['marketplace', '站点'], ['title', '标题'], ['brand', '品牌'], ['color', '颜色'], ['parentAsin', '父 ASIN'],
    ['rating', '星级'], ['reviewCount', '评分数量'], ['categoryPath', '类目路径'], ['bsr', 'BSR / 畅销排名'],
    ['mainImageUrl', '主图 URL'], ['imageCount', '图片数量'], ['bulletPoints', '五点描述'],
    ['productDescription', '商品描述'], ['batchStatus', '队列状态'], ['errorReason', '错误原因'], ['capturedAt', '采集时间'], ['url', '商品链接']
  ];
  const defaultSettings = { autoCapture: true, autoCollapse: true, retryAttempts: 20, exportFormat: 'csv', selectedExportFields: exportFields.map(([key]) => key), dataFilePrefix: 'Amazon商品信息采集器', imageZipPrefix: 'Amazon商品图片', imageManifestPrefix: 'Amazon图片清单' };
  const siteOptions = ['amazon.de', 'amazon.com', 'amazon.co.uk', 'amazon.fr', 'amazon.it', 'amazon.es', 'amazon.nl', 'amazon.pl', 'amazon.se', 'amazon.ca', 'amazon.com.au', 'amazon.co.jp'];
  let records = [];
  let history = [];
  let settings = { ...defaultSettings };
  let collapsed = false;
  let lastRecord = null;
  let activeSection = null;
  let batchQueue = { active: false, items: [], index: 0, marketplace: '', navigating: false, redirectAttempts: 0 };

  const cleanText = value => (value || '').replace(/\s+/g, ' ').trim();
  const marketplace = () => location.hostname.replace(/^www\./, '');
  const numberFromText = value => cleanText(value).replace(/\u00a0/g, ' ').match(/[\d][\d.,\s']*/)?.[0].trim() || '';
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const safeFilePart = value => String(value || '').replace(/[\\/:*?"<>|\r\n]+/g, '_').trim() || 'Amazon商品信息采集器';
  const today = () => new Date().toISOString().slice(0, 10);
  const feedbackMailto = () => `mailto:qing_guo2000@outlook.com?subject=${encodeURIComponent(`Amazon 商品信息采集器反馈 v${VERSION}`)}&body=${encodeURIComponent(`您好，\n\n问题/建议：\n\n当前版本：v${VERSION}\n当前页面：${location.href}\nASIN：${getAsin() || '未识别'}\n站点：${marketplace()}\n\n谢谢。`)}`;

  function alipayQrBits() {
    return [...ALIPAY_QR_HEX].flatMap(char => [...Number.parseInt(char, 16).toString(2).padStart(4, '0')]).slice(0, 41 * 41);
  }

  function drawAlipayQr() {
    const canvas = document.querySelector(`#${PANEL_ID} .arc-alipay-qr`);
    if (!canvas) return;
    const bits = alipayQrBits();
    const scale = 4, quiet = 4;
    canvas.width = canvas.height = (41 + quiet * 2) * scale;
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#000';
    bits.forEach((bit, index) => {
      if (bit === '1') context.fillRect((index % 41 + quiet) * scale, (Math.floor(index / 41) + quiet) * scale, scale, scale);
    });
  }

  function getAsin() {
    const match = decodeURIComponent(location.pathname).match(/\/(?:dp|gp\/product|商品)\/([A-Z0-9]{10})(?:[/?]|$)/i);
    if (match) return match[1].toUpperCase();
    const canonical = document.querySelector('link[rel="canonical"]')?.href || '';
    return canonical.match(/\/(?:dp|gp\/product|商品)\/([A-Z0-9]{10})/i)?.[1].toUpperCase() || '';
  }

  function extractRating() {
    const element = document.querySelector('#acrPopover, [data-hook="rating-out-of-text"], #averageCustomerReviews .a-icon-alt');
    const text = cleanText(element?.getAttribute('title') || element?.getAttribute('aria-label') || element?.textContent);
    return text.match(/5\s*つ星のうち\s*(\d[\d.,]*)/i)?.[1] || text.match(/(\d[\d.,]*)\s*(?:out of|von|sur|su|de)\s*5/i)?.[1] || text.match(/\b(\d[\d.,]*)\b/)?.[1] || '';
  }

  function extractJsonLd() {
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const data = JSON.parse(script.textContent);
        const roots = Array.isArray(data) ? data : [data];
        const product = roots.flatMap(item => [item, ...(Array.isArray(item?.['@graph']) ? item['@graph'] : [])]).find(item => item?.aggregateRating);
        if (product?.aggregateRating) return product.aggregateRating;
      } catch (_) { /* 忽略不完整 JSON-LD。 */ }
    }
    return {};
  }

  function textFrom(selector) {
    return cleanText(document.querySelector(selector)?.textContent);
  }

  function unique(items) {
    return [...new Set(items.filter(Boolean))];
  }

  function imageKey(url) {
    try {
      const pathname = decodeURIComponent(new URL(url).pathname);
      return pathname.match(/\/images\/(?:I|G)\/([^./]+)/i)?.[1] || pathname;
    } catch (_) { return url; }
  }

  function dedupeImageUrls(urls) {
    const selected = new Map();
    const score = url => (/\._[^.]+_|\.(?:SL|SX|SY|AC|CR|US|SS)\d+_/i.test(url) ? 0 : 10) + (/hires|large|zoom/i.test(url) ? 5 : 0);
    for (const url of urls.filter(Boolean)) {
      const key = imageKey(url); const current = selected.get(key);
      if (!current || score(url) > score(current)) selected.set(key, url);
    }
    return [...selected.values()];
  }

  function highestQualityUrl(url) {
    // Amazon 图片 URL 中的尺寸指令会生成缩略图；去除所有尺寸/裁剪指令，回到原图路径。
    return String(url || '').replace(/\._[^.\/]*_(?=\.)/gi, '').replace(/\.(?:SL|SX|SY|AC|CR|US|SS)\d+_/gi, '');
  }

  function imageUrlsFromDynamicImage(value) {
    if (!value) return [];
    try {
      const candidates = Object.entries(JSON.parse(value));
      return candidates.sort((a, b) => (b[1][0] * b[1][1]) - (a[1][0] * a[1][1])).map(([url]) => highestQualityUrl(url));
    } catch (_) {
      return [];
    }
  }

  function extractViewerImages(root = document) {
    const urls = [];
    const add = value => { if (!value) return; try { urls.push(highestQualityUrl(JSON.parse(`"${value}"`))); } catch (_) { urls.push(highestQualityUrl(value.replace(/\\u002F/g, '/').replace(/\\\//g, '/'))); } };
    root.querySelectorAll('script').forEach(script => {
      const source = script.textContent || '';
      const matcher = /["'](?:hiRes|large|mainUrl|zoomUrl)["']\s*:\s*["']([^"']+)["']/gi;
      let match;
      while ((match = matcher.exec(source))) add(match[1]);
    });
    return unique(urls).filter(url => /m\.media-amazon\.com|images-amazon\.com/i.test(url));
  }

  function extractImages() {
    const main = document.querySelector('#landingImage, #imgTagWrapperId img, #main-image-container img');
    const gallery = [...document.querySelectorAll('#altImages img, #imageBlockThumbs img, [data-csa-c-content-id="image-block"] img')];
    const urls = unique([
      ...extractViewerImages(),
      ...imageUrlsFromDynamicImage(main?.getAttribute('data-a-dynamic-image')),
      highestQualityUrl(main?.getAttribute('data-old-hires')),
      highestQualityUrl(main?.currentSrc || main?.src),
      ...gallery.flatMap(image => imageUrlsFromDynamicImage(image.getAttribute('data-a-dynamic-image'))),
      ...gallery.map(image => highestQualityUrl(image.getAttribute('data-old-hires') || image.currentSrc || image.src))
    ]);
    const productImages = dedupeImageUrls(urls.filter(url => !/play-button|video|sprite/i.test(url)));
    return { mainImageUrl: productImages[0] || '', imageUrls: productImages, imageCount: productImages.length };
  }

  function extractAPlusImages() {
    const root = document.querySelector('#aplus, #aplus_feature_div, #aplus3p_feature_div');
    if (!root) return [];
    const urls = [...root.querySelectorAll('img')].flatMap(image => [
      ...imageUrlsFromDynamicImage(image.getAttribute('data-a-dynamic-image')),
      highestQualityUrl(image.currentSrc || image.getAttribute('data-src') || image.src)
    ]);
    return dedupeImageUrls(urls.filter(url => !/sprite|play-button|video/i.test(url)));
  }

  function extractParentAsin() {
    const html = document.documentElement.innerHTML;
    return html.match(/["']parentAsin["']\s*[:=]\s*["']([A-Z0-9]{10})/i)?.[1]?.toUpperCase() || '';
  }

  function extractVariants() {
    const values = [...document.querySelectorAll('[id^="variation_"] .selection, [id^="variation_"] .a-dropdown-prompt, [id^="variation_"] [aria-checked="true"]')]
      .map(element => cleanText(element.textContent));
    return unique(values).join(' | ');
  }

  function extractColor(itemDetails = {}) {
    const detailKey = Object.keys(itemDetails).find(key => /^(?:color|colour|farbe|couleur|colore|カラー|颜色|顏色)$/i.test(cleanText(key)));
    if (detailKey && itemDetails[detailKey]) return cleanText(itemDetails[detailKey]);
    const detailRows = [...document.querySelectorAll('#productDetails_detailBullets_sections1 tr, #productDetails_techSpec_section_1 tr, #detailBullets_feature_div li, #prodDetails tr')];
    for (const row of detailRows) {
      const cells = [...row.querySelectorAll('th, td, .a-color-secondary, .a-span3, .a-span9')].map(cell => cleanText(cell.textContent)).filter(Boolean);
      if (cells.length >= 2 && /^(?:color|colour|farbe|couleur|colore|カラー|颜色|顏色)$/i.test(cells[0].replace(/[:：]$/, '').trim())) return cells.slice(1).join(' ');
      const text = cleanText(row.textContent);
      const match = text.match(/^(?:color|colour|farbe|couleur|colore|カラー|颜色|顏色)\s*[:：]?\s*(.+)$/i);
      if (match?.[1]) return cleanText(match[1]);
    }
    const variation = [...document.querySelectorAll('[id^="variation_"]')].find(node => /color|colour|farbe|couleur|colore|カラー|颜色|顏色/i.test(cleanText(node.querySelector('label, .a-form-label, .a-row')?.textContent || node.id)));
    const selected = variation?.querySelector('.selection, .a-dropdown-prompt, [aria-checked="true"], [data-csa-c-item-id][aria-selected="true"]');
    const selectedText = cleanText(selected?.getAttribute('aria-label') || selected?.getAttribute('title') || selected?.textContent);
    if (selectedText) return selectedText.replace(/^(?:color|colour|farbe|couleur|colore|カラー|颜色|顏色)\s*[:：-]?\s*/i, '').trim();
    const swatch = document.querySelector('[id*="color" i] li[aria-checked="true"], [id*="color" i] [aria-selected="true"], [data-csa-c-content-id*="color" i] [aria-checked="true"]');
    const swatchText = cleanText(swatch?.getAttribute('aria-label') || swatch?.getAttribute('title') || swatch?.textContent);
    if (swatchText) return swatchText.replace(/^(?:color|colour|farbe|couleur|colore|カラー|颜色|顏色)\s*[:：-]?\s*/i, '').trim();
    const htmlColor = document.documentElement.innerHTML.match(/["']color["']\s*[:=]\s*["']([^"']{1,100})["']/i)?.[1];
    return cleanText(htmlColor);
  }

  function extractCategoryPath() {
    return unique([...document.querySelectorAll('#wayfinding-breadcrumbs_feature_div a, #wayfinding-breadcrumbs_container a')].map(link => cleanText(link.textContent))).join(' > ');
  }

  function extractBsr() {
    const labels = /best\s+sellers\s+rank|amazon-bestseller-rang|classement\s+des\s+meilleures|clasificación.*vendidos|ベストセラー順位/i;
    for (const row of document.querySelectorAll('#productDetails_detailBullets_sections1 tr, #productDetails_db_sections tr, #detailBullets_feature_div li')) {
      const text = cleanText(row.textContent);
      if (labels.test(text)) return text.replace(/^[^:#：]+[#：:]\s*/i, '').trim();
    }
    return '';
  }

  function extractItemDetails() {
    const details = {};
    for (const row of document.querySelectorAll('#productDetails_detailBullets_sections1 tr, #productDetails_techSpec_section_1 tr, #detailBullets_feature_div li')) {
      const cells = [...row.querySelectorAll('th, td')].map(cell => cleanText(cell.textContent)).filter(Boolean);
      if (cells.length >= 2) details[cells[0].replace(/[:：]$/, '')] = cells.slice(1).join(' ');
    }
    return details;
  }

  function visibleText(selector) {
    const source = document.querySelector(selector);
    if (!source) return '';
    const clone = source.cloneNode(true);
    clone.querySelectorAll('script, style, noscript, template, svg, img').forEach(node => node.remove());
    return cleanText(clone.textContent);
  }

  function extractBullets() {
    return unique([...document.querySelectorAll('#feature-bullets li .a-list-item, #featurebullets_feature_div li')].map(item => cleanText(item.textContent))).join('\n');
  }

  function extractAPlusText() {
    return unique([...document.querySelectorAll('#aplus, #aplus_feature_div, #aplus3p_feature_div')].map(item => {
      const clone = item.cloneNode(true);
      clone.querySelectorAll('script, style, noscript, template, svg, img, video, button, nav, [aria-hidden="true"], [class*="video" i], [class*="carousel" i], [class*="slider" i], [class*="modal" i], [class*="brand" i]').forEach(node => node.remove());
      const raw = clone.innerText || clone.textContent || '';
      const lines = raw.split(/\n+/).map(cleanText).filter(Boolean).filter(line => !/^(previous page|next page|learn more|visit the store|video player|loading|click to play|play|mute|current time|duration|stream type|seek to live|remaining time|playback rate|chapters|descriptions off|captions|this is a modal window)$/i.test(line));
      return unique(lines).join(' ');
    })).filter(text => text.length > 0).join('\n');
  }

  function collect() {
    const asin = getAsin();
    if (!asin) return null;
    const aggregateRating = extractJsonLd();
    const reviewElement = document.querySelector('#acrCustomerReviewText, [data-hook="total-review-count"], #averageCustomerReviews a[href*="review"]');
    const images = extractImages();
    const aPlusImageUrls = extractAPlusImages();
    const itemDetails = extractItemDetails();
    return {
      asin, marketplace: marketplace(),
      title: cleanText(document.querySelector('#productTitle, h1[data-automation-id="title"]')?.textContent || document.title),
      brand: itemDetails.Brand || itemDetails.Marke || itemDetails['Brand Name'] || cleanText(document.querySelector('#bylineInfo, #brand')?.textContent).replace(/^(?:Visit the|Brand:|Marke:|品牌：)\s*/i, '').replace(/\s+Store$/i, ''),
      color: extractColor(itemDetails),
      parentAsin: extractParentAsin(),
      selectedVariants: extractVariants(),
      rating: extractRating() || cleanText(aggregateRating.ratingValue),
      reviewCount: numberFromText(reviewElement?.textContent) || numberFromText(aggregateRating.reviewCount),
      availability: textFrom('#availability, #availabilityInsideBuyBox, #outOfStock'),
      categoryPath: extractCategoryPath(),
      bsr: extractBsr() || itemDetails['Best Sellers Rank'] || itemDetails['Amazon-Bestseller-Rang'] || '',
      bulletPoints: extractBullets(),
      productDescription: visibleText('#productDescription, #productDescription_feature_div'),
      aPlusImageUrls,
      ...images,
      url: location.href, capturedAt: new Date().toISOString()
    };
  }

  async function saveAll() {
    await chrome.storage.local.set({ [STORAGE_KEY]: records, [HISTORY_KEY]: history, [SETTINGS_KEY]: settings, [BATCH_KEY]: batchQueue });
  }

  function parseBatchAsins(value) {
    return [...new Set((String(value || '').toUpperCase().match(/\b[A-Z0-9]{10}\b/g) || []))];
  }

  function detectPageError() {
    if (document.querySelector('#captchacharacters, form[action*="validateCaptcha" i], input[name="field-keywords"][aria-label*="captcha" i]')) return 'Amazon 验证码页面';
    const title = cleanText(document.title);
    const body = cleanText(document.body?.innerText).slice(0, 12000);
    if (/robot check|enter the characters|sorry, we just need to make sure|请证明你不是机器人|验证码/i.test(`${title} ${body}`)) return 'Amazon 验证码或机器人验证';
    if (/page not found|商品不存在|找不到该商品|item not found|requested page could not be found|404/i.test(`${title} ${body}`)) return '商品页面不存在（404）';
    if (/currently unavailable|currently out of stock|商品不可用|暂时缺货|unavailable/i.test(body) && !document.querySelector('#productTitle')) return '商品不可用或页面异常';
    return '';
  }

  function batchProductUrl(asin) {
    const host = batchQueue.marketplace || marketplace();
    return `https://www.${host.startsWith('amazon.') ? host : `amazon.${host}`}/dp/${asin}`;
  }

  async function startBatch() {
    const input = document.querySelector('[data-batch-input]');
    const items = parseBatchAsins(input?.value);
    if (!items.length) return alert('请先粘贴至少一个有效 ASIN（每个 10 位）');
    const site = document.querySelector('[data-batch-site]')?.value || marketplace();
    if (!siteOptions.includes(site)) return alert('请选择有效的 Amazon 站点');
    batchQueue = { active: true, items, index: 0, marketplace: site, navigating: false, redirectAttempts: 0 };
    await saveAll();
    const current = getAsin();
    if (current === items[0]) {
      await capture();
      return;
    }
    location.href = batchProductUrl(items[0]);
  }

  async function stopBatch() {
    batchQueue = { active: false, items: [], index: 0, marketplace: '', navigating: false, redirectAttempts: 0 };
    await saveAll();
    updatePanel('批量队列已停止');
  }

  async function markBatchError(reason) {
    if (!batchQueue.active) return false;
    const asin = batchQueue.items[batchQueue.index];
    if (!asin) return false;
    const failed = { asin, marketplace: batchQueue.marketplace || marketplace(), batchStatus: 'error', errorReason: reason, url: location.href, capturedAt: new Date().toISOString() };
    const index = records.findIndex(item => item.asin === asin && item.marketplace === failed.marketplace);
    if (index >= 0) records[index] = { ...records[index], ...failed };
    else records.push(failed);
    history.push(failed);
    batchQueue.index += 1;
    await saveAll();
    if (batchQueue.index >= batchQueue.items.length) {
      batchQueue.active = false;
      await saveAll();
      updatePanel(`批量完成：${asin} 失败（${reason}），其余队列已处理`, true);
      return true;
    }
    const next = batchQueue.items[batchQueue.index];
    batchQueue.navigating = true;
    batchQueue.redirectAttempts = 0;
    await saveAll();
    updatePanel(`已记录错误：${asin}（${reason}），继续 ${batchQueue.index + 1} / ${batchQueue.items.length}`);
    setTimeout(() => { location.href = batchProductUrl(next); }, 800);
    return true;
  }

  async function advanceBatch(record) {
    if (!batchQueue.active || batchQueue.navigating) return;
    const expected = batchQueue.items[batchQueue.index];
    if (record.asin !== expected) return;
    batchQueue.index += 1;
    if (batchQueue.index >= batchQueue.items.length) {
      batchQueue.active = false;
      await saveAll();
      updatePanel(`√ 批量采集完成，共 ${batchQueue.items.length} 个 ASIN`, true);
      return;
    }
    const next = batchQueue.items[batchQueue.index];
    batchQueue.navigating = true;
    batchQueue.redirectAttempts = 0;
    await saveAll();
    updatePanel(`√ 已读取 ${batchQueue.index} / ${batchQueue.items.length}，准备下一个…`);
    setTimeout(() => { location.href = batchProductUrl(next); }, 1200);
  }

  function selectedFields() {
    const keys = Array.isArray(settings.selectedExportFields) ? settings.selectedExportFields : defaultSettings.selectedExportFields;
    return exportFields.filter(([key]) => keys.includes(key));
  }

  async function checkUpdate() {
    try {
      const response = await fetch(`${UPDATE_URL}?t=${Date.now()}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(response.status);
      const remote = await response.json();
      if (remote.version && remote.version !== VERSION) {
        if (confirm(`发现新版本 v${remote.version}\n${remote.notes || ''}\n\n是否打开下载地址？`) && remote.download) window.open(remote.download, '_blank', 'noopener');
      } else alert(`当前已是最新版本 v${VERSION}`);
    } catch (_) { alert('暂时无法连接 GitHub 检查更新，请稍后重试。'); }
  }

  async function capture() {
    const record = collect();
    if (!record) return updatePanel('当前页面不是商品详情页');
    const pageError = batchQueue.active ? detectPageError() : '';
    if (pageError) { await markBatchError(pageError); return true; }
    const isQueuedRecord = batchQueue.active && batchQueue.items[batchQueue.index] === record.asin;
    if (batchQueue.active && !isQueuedRecord) {
      const expected = batchQueue.items[batchQueue.index];
      const attempts = Number(batchQueue.redirectAttempts || 0);
      if (expected && attempts >= 1) {
        const actual = record.asin;
        batchQueue.redirectAttempts = 0;
        await chrome.storage.local.set({ [BATCH_KEY]: batchQueue });
        await markBatchError(`Amazon 自动跳转到其他变体（目标 ${expected}，实际 ${actual}）`);
        return true;
      }
      if (expected && !batchQueue.navigating) {
        batchQueue.redirectAttempts = attempts + 1;
        batchQueue.navigating = true;
        await chrome.storage.local.set({ [BATCH_KEY]: batchQueue });
        location.replace(batchProductUrl(expected));
        return false;
      }
      updatePanel(`队列等待目标 ASIN：${batchQueue.items[batchQueue.index] || '已完成'}`);
      return false;
    }
    const hasProductData = Boolean(document.querySelector('#productTitle, h1[data-automation-id="title"]') || record.imageUrls?.length || record.brand || record.bulletPoints || record.productDescription);
    if (!hasProductData) return updatePanel('未读取到足够商品信息；正在等待页面加载或检查验证码');
    if (batchQueue.active) { record.batchStatus = 'success'; record.errorReason = ''; }
    const index = records.findIndex(item => item.asin === record.asin && item.marketplace === record.marketplace);
    if (index >= 0) {
      records[index] = { ...records[index], ...record, rating: record.rating || records[index].rating, reviewCount: record.reviewCount || records[index].reviewCount };
      lastRecord = records[index];
    } else {
      records.push(record);
      lastRecord = record;
    }
    history.push({ ...lastRecord, capturedAt: record.capturedAt });
    await saveAll();
    updatePanel(record.rating || record.reviewCount ? '√ 已成功读取' : '√ 已成功读取（该页面无星级）', true);
    await advanceBatch(lastRecord);
    return true;
  }

  function updatePanel(status, success = false) {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    const current = collect();
    panel.querySelector('[data-role="status"]').textContent = status || (current ? `${current.asin}：${current.rating || '未读取星级'} 星，${current.reviewCount || '未读取评分数'}` : '当前页面不是商品详情页');
    panel.querySelector('[data-role="count"]').textContent = `最新记录 ${records.length} 条｜历史快照 ${history.length} 条`;
    if (success && settings.autoCollapse) collapsed = true;
    panel.classList.toggle('arc-collapsed', collapsed);
    renderDrawer();
  }

  function exportData(kind = 'latest') {
    const data = kind === 'history' ? history : records;
    if (!data.length) return alert('还没有可导出的记录');
    const fields = selectedFields();
    if (!fields.length) return alert('请至少勾选一个导出字段');
    if (settings.exportFormat === 'json') {
      const filtered = data.map(row => Object.fromEntries(fields.map(([key]) => [key, row[key]])));
      const link = document.createElement('a');
      link.href = URL.createObjectURL(new Blob([JSON.stringify(filtered, null, 2)], { type: 'application/json;charset=utf-8' }));
      link.download = `${safeFilePart(settings.dataFilePrefix)}_${kind}_${today()}.json`;
      link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000); return;
    }
    const columns = fields.flatMap(([key]) => key === 'bulletPoints'
      ? ['bulletPoint1', 'bulletPoint2', 'bulletPoint3', 'bulletPoint4', 'bulletPoint5']
      : [key]);
    const quote = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
    const csv = '\ufeff' + [columns.join(','), ...data.map(row => {
      const bullets = String(row.bulletPoints || '').split(/\n+/).map(cleanText).filter(Boolean);
      return columns.map(key => quote(key.startsWith('bulletPoint') ? bullets[Number(key.slice(-1)) - 1] || '' : Array.isArray(row[key]) ? JSON.stringify(row[key]) : row[key])).join(',');
    })].join('\n');
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    link.download = `${safeFilePart(settings.dataFilePrefix)}_${kind}_${today()}.csv`;
    link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function zipBytes(files) {
    const encoder = new TextEncoder(); const chunks = []; const central = []; let offset = 0;
    const put16 = (n, at) => { at[0] = n & 255; at[1] = (n >>> 8) & 255; };
    const put32 = (n, at) => { put16(n, at); put16(n >>> 16, at.subarray(2)); };
    for (const file of files) {
      const name = encoder.encode(file.name); const data = file.data; const local = new Uint8Array(30 + name.length); put32(0x04034b50, local); put16(20, local.subarray(4)); put16(0x800, local.subarray(6)); put16(0, local.subarray(8)); put32(crc32(data), local.subarray(14)); put32(data.length, local.subarray(18)); put32(data.length, local.subarray(22)); put16(name.length, local.subarray(26)); local.set(name, 30); chunks.push(local, data);
      const entry = new Uint8Array(46 + name.length); put32(0x02014b50, entry); put16(20, entry.subarray(4)); put16(20, entry.subarray(6)); put16(0x800, entry.subarray(8)); put32(crc32(data), entry.subarray(16)); put32(data.length, entry.subarray(20)); put32(data.length, entry.subarray(24)); put16(name.length, entry.subarray(28)); put32(offset, entry.subarray(42)); entry.set(name, 46); central.push(entry); offset += local.length + data.length;
    }
    const centralSize = central.reduce((sum, part) => sum + part.length, 0); const end = new Uint8Array(22); put32(0x06054b50, end); put16(files.length, end.subarray(8)); put16(files.length, end.subarray(10)); put32(centralSize, end.subarray(12)); put32(offset, end.subarray(16));
    return new Blob([...chunks, ...central, end], { type: 'application/zip' });
  }

  async function exportImages() {
    const current = lastRecord || collect();
    const imageRecords = records.length ? records : (current ? [current] : []);
    if (!imageRecords.some(record => record?.imageUrls?.length || record?.aPlusImageUrls?.length)) return alert('当前没有可导出的商品图片');
    const files = []; const failed = [];
    const imageItems = imageRecords.flatMap(record => [
      ...(record.imageUrls || []).map((url, i) => ({ url, name: `${safeFilePart(record.asin)}/${String(i + 1).padStart(2, '0')}_${i === 0 ? 'main' : 'secondary'}.jpg` })),
      ...(record.aPlusImageUrls || []).map((url, i) => ({ url, name: `${safeFilePart(record.asin)}/aplus_${String(i + 1).padStart(2, '0')}.jpg` }))
    ]);
    for (const item of imageItems) {
      try { const response = await fetch(item.url); if (!response.ok) throw new Error(response.status); files.push({ name: item.name, data: new Uint8Array(await response.arrayBuffer()) }); } catch (_) { failed.push(item.url); }
    }
    if (!files.length) return alert('图片服务器拒绝浏览器读取，无法生成 ZIP；可使用导出的图片 URL 清单下载。');
    const link = document.createElement('a'); link.href = URL.createObjectURL(zipBytes(files)); link.download = `${safeFilePart(settings.imageZipPrefix)}_${imageRecords.length}个ASIN_${today()}.zip`; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    if (failed.length) alert(`已导出 ${files.length} 张图片，${failed.length} 张因跨域或服务器限制失败。`);
  }

  function exportImageManifest() {
    const data = records.flatMap(record => [
      ...(record.imageUrls || []).map((url, index) => ({ asin: record.asin, marketplace: record.marketplace, imageIndex: index + 1, imageType: index === 0 ? 'main' : 'secondary', imageUrl: url })),
      ...(record.aPlusImageUrls || []).map((url, index) => ({ asin: record.asin, marketplace: record.marketplace, imageIndex: index + 1, imageType: 'aplus', imageUrl: url }))
    ]);
    if (!data.length) return alert('没有可导出的图片 URL');
    const columns = ['asin', 'marketplace', 'imageIndex', 'imageType', 'imageUrl'];
    const quote = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
    const csv = '\ufeff' + [columns.join(','), ...data.map(row => columns.map(key => quote(row[key])).join(','))].join('\n');
    const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })); link.download = `${safeFilePart(settings.imageManifestPrefix)}_${today()}.csv`; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  function renderDrawer() {
    const drawer = document.querySelector(`#${PANEL_ID} [data-role="drawer"]`);
    if (!drawer) return;
    const record = lastRecord || collect();
    drawer.innerHTML = `
      <div class="arc-section-title">常用</div>
      <button class="arc-nav" data-action="toggle-section" data-target="batch"><span>批量采集队列</span><small>${batchQueue.active ? `进行中：${Math.min(batchQueue.index + 1, batchQueue.items.length)} / ${batchQueue.items.length}` : '一次输入多个 ASIN，自动逐页采集'}</small><b>›</b></button>
      <section class="arc-panel-section" data-section="batch" ${activeSection === 'batch' ? '' : 'hidden'}><label>目标站点 <select data-batch-site>${siteOptions.map(site => `<option value="${site}" ${(batchQueue.marketplace || marketplace()) === site ? 'selected' : ''}>${site}</option>`).join('')}</select></label><textarea data-batch-input rows="5" placeholder="粘贴多个 ASIN、Amazon 链接或混合文本">${escapeHtml(batchQueue.items.join('\n'))}</textarea><small>采集成功后自动打开下一个页面，数据和图片 URL 会保存到现有记录。</small><button data-action="start-batch">▶ 开始 / 重置队列</button><button data-action="stop-batch">■ 停止队列</button>${batchQueue.active ? `<p class="arc-batch-progress">正在采集第 ${Math.min(batchQueue.index + 1, batchQueue.items.length)} / ${batchQueue.items.length} 个：${escapeHtml(batchQueue.items[batchQueue.index] || '已完成')}</p>` : ''}</section>
      <button class="arc-nav" data-action="toggle-section" data-target="preview"><span>本页数据预览</span><small>查看刚采集的字段</small><b>›</b></button>
      <section class="arc-panel-section" data-section="preview" ${activeSection === 'preview' ? '' : 'hidden'}><div class="arc-preview">${record ? `ASIN：${escapeHtml(record.asin)}<br>品牌：${escapeHtml(record.brand || '未读取')}<br>颜色：${escapeHtml(record.color || '未读取')}<br>父 ASIN：${escapeHtml(record.parentAsin || '未读取')}<br>星级：${escapeHtml(record.rating || '未读取')}<br>评分数量：${escapeHtml(record.reviewCount || '未读取')}<br>类目：${escapeHtml(record.categoryPath || '未读取')}<br>BSR：${escapeHtml(record.bsr || '未读取')}<br>图片：${record.imageCount || 0} 张${record.mainImageUrl ? `<br><a href="${escapeHtml(record.mainImageUrl)}" target="_blank" rel="noreferrer">打开主图（最大公开规格）</a>` : ''}` : '尚未成功读取本页数据'}</div></section>
      <button class="arc-nav" data-action="toggle-section" data-target="data"><span>导出与数据</span><small>导出、清空和历史快照</small><b>›</b></button>
      <section class="arc-panel-section" data-section="data" ${activeSection === 'data' ? '' : 'hidden'}><button data-action="export-images">导出全部图片 ZIP</button><button data-action="export-image-manifest">导出全部图片清单 CSV</button></section>
      <div class="arc-section-title">设置</div>
      <button class="arc-nav" data-action="toggle-section" data-target="settings"><span>⚙ 功能设置</span><small>采集、折叠、重试、导出字段</small><b>›</b></button>
      <section class="arc-panel-section" data-section="settings" ${activeSection === 'settings' ? '' : 'hidden'}>
        <label><input type="checkbox" data-setting="autoCapture" ${settings.autoCapture ? 'checked' : ''}> 自动采集</label>
        <label><input type="checkbox" data-setting="autoCollapse" ${settings.autoCollapse ? 'checked' : ''}> 成功后自动缩小</label>
        <label>重试次数 <input type="number" min="1" max="60" data-setting="retryAttempts" value="${settings.retryAttempts}"></label>
        <label>导出格式 <select data-setting="exportFormat"><option value="csv" ${settings.exportFormat === 'csv' ? 'selected' : ''}>CSV</option><option value="json" ${settings.exportFormat === 'json' ? 'selected' : ''}>JSON</option></select></label>
        <label>数据文件名前缀 <input type="text" data-setting="dataFilePrefix" value="${escapeHtml(settings.dataFilePrefix)}"></label>
        <label>图片 ZIP 文件名前缀 <input type="text" data-setting="imageZipPrefix" value="${escapeHtml(settings.imageZipPrefix)}"></label>
        <label>图片清单文件名前缀 <input type="text" data-setting="imageManifestPrefix" value="${escapeHtml(settings.imageManifestPrefix)}"></label>
        <small>保存路径由浏览器下载设置决定；如需每次选择文件夹，请开启 Chrome / Edge 的“下载前询问每个文件的保存位置”。</small>
        <div class="arc-export-fields"><b>导出字段</b><button data-action="select-all-fields">全选</button><button data-action="clear-fields">清空</button>${exportFields.map(([key, label]) => `<label><input type="checkbox" data-export-field="${key}" ${selectedFields().some(([selected]) => selected === key) ? 'checked' : ''}> ${label}</label>`).join('')}</div>
      </section>
      <div class="arc-section-title">关于</div>
      <button class="arc-nav arc-nav-secondary" data-action="toggle-section" data-target="help"><span>使用帮助</span><small>采集异常与字段说明</small><b>›</b></button>
      <section class="arc-panel-section arc-info" data-section="help" ${activeSection === 'help' ? '' : 'hidden'}><p>面板只在商品详情页显示。验证码、登录提示或 Cookie 页面无法读取。评分数量是 Amazon 显示的总评分数，可能包含未写文字的评分。</p></section>
      <button class="arc-nav arc-nav-secondary" data-action="toggle-section" data-target="changelog"><span>更新版本记录</span><small>当前 v${VERSION}</small><b>›</b></button>
      <section class="arc-panel-section arc-info" data-section="changelog" ${activeSection === 'changelog' ? '' : 'hidden'}><p><b>当前版本 v${VERSION}</b></p><button data-action="check-update">检查更新</button><p>v1.4.10：修复父子变体自动重定向造成的队列死循环。</p><p>v1.4.09：增强颜色详情表解析，并自动将颜色加入已有用户的导出字段。</p><p>v1.4.08：新增颜色数据采集并加入导出字段。</p></section>
      <button class="arc-nav arc-nav-secondary" data-action="toggle-section" data-target="support"><span>♡ 打赏 / 支持作者</span><small>自愿支持，不影响功能使用</small><b>›</b></button>
      <section class="arc-panel-section arc-info" data-section="support" ${activeSection === 'support' ? '' : 'hidden'}><p>感谢使用。本扩展所有功能均可免费使用。</p><p><b>作者联系方式</b><br><a href="mailto:qing_guo2000@outlook.com">qing_guo2000@outlook.com</a><br><a href="${feedbackMailto()}">✉ 发送反馈邮件（自动填写模板）</a><br>有任何疑问或需求可以联系。</p><p><b>支付宝打赏</b><br><span class="arc-qr-hint">请使用支付宝扫一扫</span><canvas class="arc-alipay-qr" width="196" height="196" aria-label="支付宝收款二维码"></canvas></p></section>`;
    drawAlipayQr();
  }

  function createPanel() {
    if (document.getElementById(PANEL_ID)) return;
    const panel = document.createElement('section'); panel.id = PANEL_ID;
    panel.innerHTML = '<div class="arc-summary"><strong>Amazon 商品信息采集器</strong><button class="arc-toggle" data-action="toggle">隐藏</button></div><div data-role="status">正在读取商品数据…</div><div class="arc-details"><div class="arc-toolbar"><button class="arc-btn arc-btn-primary" data-action="capture">↻ 重新读取 <em>Alt+R</em></button><button class="arc-btn arc-btn-export" data-action="export">↓ 导出最新</button><button class="arc-btn arc-btn-export-light" data-action="export-history">↓ 导出历史</button><button class="arc-btn arc-btn-danger" data-action="clear">清空最新</button><button class="arc-btn arc-btn-danger-light" data-action="clear-history">清空历史</button><button class="arc-btn arc-btn-more" data-action="more">⚙ 设置 / 更多</button></div><small data-role="count"></small><div class="arc-drawer" data-role="drawer" hidden></div></div>';
    const style = document.createElement('style');
    style.textContent = `#${PANEL_ID}{position:fixed;right:16px;bottom:16px;z-index:2147483647;width:310px;max-height:calc(100vh - 32px);box-sizing:border-box;padding:12px;color:#111;background:#fff;border:2px solid #146eb4;border-radius:10px;box-shadow:0 4px 18px #0003;font:14px Arial,sans-serif}#${PANEL_ID} [hidden]{display:none !important}#${PANEL_ID} .arc-summary{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}#${PANEL_ID} [data-role=status]{display:block;margin-bottom:9px;color:#444}#${PANEL_ID} .arc-details{max-height:calc(100vh - 120px);overflow-y:auto;padding-right:3px}#${PANEL_ID} .arc-toolbar{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:7px}#${PANEL_ID} button,#${PANEL_ID} select,#${PANEL_ID} input{font:inherit;margin:0;padding:6px 9px;border:1px solid #c4cbd3;border-radius:6px;background:#f7f8fa;cursor:pointer;transition:background .15s,border-color .15s,transform .05s,box-shadow .15s}#${PANEL_ID} button:hover{filter:brightness(.97);box-shadow:0 1px 4px #0002}#${PANEL_ID} button:active{transform:translateY(1px)}#${PANEL_ID} .arc-btn{white-space:nowrap;font-size:12px;font-weight:600}#${PANEL_ID} .arc-btn em{font-size:10px;font-style:normal;opacity:.78;font-weight:400}#${PANEL_ID} .arc-btn-primary{color:#fff;background:#1769aa;border-color:#1769aa;box-shadow:0 2px 5px #1769aa44}#${PANEL_ID} .arc-btn-export{color:#fff;background:#2e7d32;border-color:#2e7d32}#${PANEL_ID} .arc-btn-export-light{color:#28632c;background:#edf7ee;border-color:#9bcaa0}#${PANEL_ID} .arc-btn-danger{color:#fff;background:#b3261e;border-color:#b3261e}#${PANEL_ID} .arc-btn-danger-light{color:#9d2424;background:#fff1f0;border-color:#e2a6a2}#${PANEL_ID} .arc-btn-more{color:#4f5965;background:#f1f3f5;border-color:#d1d7dd}#${PANEL_ID} input[type=checkbox]{vertical-align:middle}#${PANEL_ID} input[type=number]{width:50px}#${PANEL_ID} .arc-toggle{margin:0;padding:3px 7px;font-size:11px;color:#68727d;background:#fff;border-color:#d8dde3}#${PANEL_ID} small{display:block;color:#666}#${PANEL_ID} .arc-section-title{margin:13px 0 6px;color:#777;font-size:12px;font-weight:bold}#${PANEL_ID} .arc-danger{color:#9d2424}#${PANEL_ID} .arc-nav{display:grid;grid-template-columns:1fr auto;gap:2px;width:100%;margin:4px 0;padding:8px;text-align:left;background:#f7f7f7;border-color:#ddd}#${PANEL_ID} .arc-nav span{font-weight:bold}#${PANEL_ID} .arc-nav small{grid-column:1;color:#777;font-size:11px}#${PANEL_ID} .arc-nav b{grid-column:2;grid-row:1 / span 2;align-self:center;color:#777;font-size:18px}#${PANEL_ID} .arc-nav-secondary{background:#fff;border-style:dashed}#${PANEL_ID} .arc-panel-section{margin:0 0 8px;padding:8px;border:1px solid #ddd;border-top:0;border-radius:0 0 6px 6px;background:#fafafa}#${PANEL_ID} .arc-panel-section label{display:block;margin:7px 0}#${PANEL_ID} p{margin:7px 0;line-height:1.45}#${PANEL_ID} .arc-preview{line-height:1.45;word-break:break-word}#${PANEL_ID} .arc-export-fields{margin-top:8px;padding-top:7px;border-top:1px dashed #bbb}#${PANEL_ID} .arc-export-fields label{display:inline-block;width:46%;margin:4px 0}#${PANEL_ID} .arc-qr-hint{color:#666;font-size:12px}#${PANEL_ID} .arc-alipay-qr{display:block;width:180px;height:180px;margin-top:8px;background:#fff;image-rendering:pixelated}#${PANEL_ID}.arc-collapsed{width:auto;min-width:0;padding:7px 9px;border-color:#2e7d32}#${PANEL_ID}.arc-collapsed .arc-summary{display:none}#${PANEL_ID}.arc-collapsed [data-role=status]{margin:0;color:#1b5e20;font-weight:bold;cursor:pointer}#${PANEL_ID}.arc-collapsed .arc-details{display:none}`;
    document.head.appendChild(style); document.body.appendChild(panel); renderDrawer();
    panel.addEventListener('click', async event => {
      const control = event.target.closest('[data-action]');
      const action = control?.dataset.action;
      if (action === 'toggle' || (collapsed && event.target.dataset.role === 'status')) { collapsed = !collapsed; updatePanel(); return; }
      if (action === 'capture') await capture();
      if (action === 'start-batch') await startBatch();
      if (action === 'stop-batch') await stopBatch();
      if (action === 'more') { const drawer = panel.querySelector('[data-role="drawer"]'); drawer.hidden = !drawer.hidden; if (!drawer.hidden) { activeSection = null; renderDrawer(); } }
      if (action === 'toggle-section') { const target = control.dataset.target; activeSection = activeSection === target ? null : target; renderDrawer(); }
      if (action === 'export') exportData();
      if (action === 'export-history') exportData('history');
      if (action === 'select-all-fields') { settings.selectedExportFields = exportFields.map(([key]) => key); await saveAll(); renderDrawer(); }
      if (action === 'clear-fields') { settings.selectedExportFields = []; await saveAll(); renderDrawer(); }
      if (action === 'clear' && confirm('确定清空最新记录吗？历史快照不会删除。')) { records = []; await saveAll(); updatePanel(); }
      if (action === 'clear-history' && confirm('确定清空全部历史快照吗？')) { history = []; await saveAll(); updatePanel(); }
      if (action === 'check-update') await checkUpdate();
      if (action === 'export-images') await exportImages();
      if (action === 'export-image-manifest') exportImageManifest();
    });
    panel.addEventListener('change', async event => {
      const exportField = event.target.dataset.exportField;
      if (exportField) {
        const selected = new Set(settings.selectedExportFields);
        if (event.target.checked) selected.add(exportField); else selected.delete(exportField);
        settings.selectedExportFields = [...selected];
        await saveAll();
        return;
      }
      const key = event.target.dataset.setting;
      if (!key) return;
      settings[key] = event.target.type === 'checkbox' ? event.target.checked : key === 'retryAttempts' ? Math.max(1, Math.min(60, Number(event.target.value) || defaultSettings.retryAttempts)) : event.target.value;
      await saveAll(); renderDrawer();
    });
    document.addEventListener('keydown', event => {
      if (!settings.autoCapture && event.altKey && event.key.toLowerCase() === 'r') {
        event.preventDefault();
        capture();
      }
    }, true);
  }

  async function init() {
    const stored = await chrome.storage.local.get({ [STORAGE_KEY]: [], [HISTORY_KEY]: [], [SETTINGS_KEY]: defaultSettings, [BATCH_KEY]: batchQueue });
    records = Array.isArray(stored[STORAGE_KEY]) ? stored[STORAGE_KEY] : [];
    history = Array.isArray(stored[HISTORY_KEY]) ? stored[HISTORY_KEY] : [];
    settings = { ...defaultSettings, ...stored[SETTINGS_KEY] };
    if (Array.isArray(settings.selectedExportFields) && !settings.selectedExportFields.includes('color')) settings.selectedExportFields = [...settings.selectedExportFields, 'color'];
    batchQueue = { ...batchQueue, ...(stored[BATCH_KEY] || {}) };
    if (batchQueue.navigating) { batchQueue.navigating = false; await chrome.storage.local.set({ [BATCH_KEY]: batchQueue }); }
    if (batchQueue.active) chrome.runtime.sendMessage({ type: 'batch-register' }).catch(() => {});
    createPanel();
    if (!settings.autoCapture && !batchQueue.active) return updatePanel('自动采集已关闭；请点击“重新读取”');
    if (batchQueue.active) {
      const expected = batchQueue.items[batchQueue.index];
      const current = getAsin();
      if (expected && current && current !== expected) {
        updatePanel(`正在纠正队列页面：${expected}`);
        location.replace(batchProductUrl(expected));
        return;
      }
    }
    let attempts = 0;
    let busy = false;
    const maxAttempts = batchQueue.active ? Math.max(settings.retryAttempts, 120) : settings.retryAttempts;
    const attempt = async () => {
      if (busy) return false;
      busy = true;
      attempts += 1;
      const done = await capture();
      busy = false;
      return done;
    };
    const timer = setInterval(async () => {
      if (await attempt()) clearInterval(timer);
      else if (attempts >= maxAttempts) {
        clearInterval(timer);
        if (batchQueue.active) await markBatchError('页面加载超时或疑似验证码');
      }
    }, 1000);
    // 页面完成加载后主动尝试一次，减少后台标签页定时器节流造成的等待。
    setTimeout(async () => { if (await attempt()) clearInterval(timer); }, 350);
  }

  if (document.body) init(); else document.addEventListener('DOMContentLoaded', init, { once: true });
})();
