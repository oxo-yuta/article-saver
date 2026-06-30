/**
 * background.js (Service Worker / MV3)
 *
 * 役割:
 *  - content から受け取った保存ジョブ(Markdown本文 + 画像URL/保存先)を実行
 *  - 画像を fetch して Vault配下にダウンロード保存
 *  - Markdown を Vault配下にダウンロード保存
 *  - 拡張アイコン/ポップアップからの保存トリガを content へ中継
 *
 * 注意: MV3のService Workerでは URL.createObjectURL が使えないため、
 *       ダウンロードには data: URL を用いる。
 */

/**
 * Blob を data: URL に変換する（Service Worker互換）。
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/**
 * 文字列を data: URL(text/markdown) に変換する。
 * @param {string} text
 * @returns {string}
 */
function textToDataUrl(text) {
  // UTF-8を安全に base64 化
  const utf8 = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < utf8.length; i++) binary += String.fromCharCode(utf8[i]);
  const b64 = btoa(binary);
  return `data:text/markdown;charset=utf-8;base64,${b64}`;
}

/**
 * chrome.downloads.download を Promise化して実行。
 * @param {object} options
 * @returns {Promise<number>} downloadId
 */
function download(options) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download(options, (downloadId) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(downloadId);
      }
    });
  });
}

/**
 * 1つの画像を fetch して保存する。
 * @param {{url:string, downloadPath:string}} image
 * @returns {Promise<boolean>} 成功したか
 */
async function saveImage(image) {
  if (!image.url) return false;
  try {
    const resp = await fetch(image.url, { credentials: 'omit' });
    if (!resp.ok) {
      console.error('[ArticleSaver] image fetch failed', resp.status, image.url);
      return false;
    }
    const blob = await resp.blob();
    const dataUrl = await blobToDataUrl(blob);
    await download({
      url: dataUrl,
      filename: image.downloadPath,
      conflictAction: 'uniquify',
      saveAs: false,
    });
    return true;
  } catch (e) {
    console.error('[ArticleSaver] saveImage error', image.url, e);
    return false;
  }
}

/**
 * 保存ジョブを実行する。
 * @param {object} job content から渡された { markdown, mdPath, images[] }
 * @returns {Promise<{ok:boolean, imageCount?:number, failedImages?:number, error?:string}>}
 */
async function runSaveJob(job) {
  if (!job || !job.markdown || !job.mdPath) {
    return { ok: false, error: 'invalid_job' };
  }

  // 画像を順次保存（並列だと downloads が詰まりやすいので直列）
  let saved = 0;
  let failed = 0;
  for (const image of job.images || []) {
    const ok = await saveImage(image);
    if (ok) saved++;
    else failed++;
  }

  // Markdown本体を保存
  try {
    await download({
      url: textToDataUrl(job.markdown),
      filename: job.mdPath,
      conflictAction: 'uniquify',
      saveAs: false,
    });
  } catch (e) {
    console.error('[ArticleSaver] markdown download failed', e);
    return { ok: false, error: 'markdown_download_failed: ' + e.message };
  }

  notify(
    '✅ Obsidianに保存しました',
    `${job.title || '記事'}\n画像 ${saved}/${saved + failed} 枚`
  );

  return { ok: true, imageCount: saved, failedImages: failed };
}

/**
 * デスクトップ通知を出す（失敗しても無視）。
 */
function notify(title, message) {
  try {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title,
      message,
    });
  } catch (e) {
    /* notifications権限が無い等は無視 */
  }
}

// ---- content からの保存ジョブを受信 ----
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'SAVE_ARTICLE') {
    runSaveJob(msg.job)
      .then((res) => sendResponse(res))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true; // 非同期応答
  }
  return false;
});

// ---- 拡張アイコンクリック（popupが無い場合のフォールバック）----
// popup を使う構成なので通常はpopup側からTRIGGER_SAVEを送るが、
// 念のため action.onClicked でもアクティブタブに保存を促す。
if (chrome.action && chrome.action.onClicked) {
  chrome.action.onClicked.addListener(async (tab) => {
    if (!tab || !tab.id) return;
    try {
      const res = await chrome.tabs.sendMessage(tab.id, { type: 'TRIGGER_SAVE' });
      if (!res || !res.ok) {
        notify('保存できませんでした', 'Xの記事ページで実行してください。');
      }
    } catch (e) {
      notify('保存できませんでした', 'このページでは実行できません。');
    }
  });
}
