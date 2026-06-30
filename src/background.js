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
 * 1つの画像を保存する。
 * - image.dataUrl があれば、それを直接ダウンロードする
 *   （汎用版はページコンテキストで既にfetch済みなので、background側の
 *    任意ホストfetchを避けられ、広範な host_permissions が不要になる）
 * - 無ければ image.url を background から fetch する（専用サイト用）
 * @param {{url?:string, dataUrl?:string, downloadPath:string}} image
 * @returns {Promise<boolean>} 成功したか
 */
async function saveImage(image) {
  if (!image.downloadPath) return false;
  try {
    let dataUrl = image.dataUrl;
    if (!dataUrl) {
      if (!image.url) return false;
      const resp = await fetch(image.url, { credentials: 'omit' });
      if (!resp.ok) {
        console.error('[ArticleSaver] image fetch failed', resp.status, image.url);
        return false;
      }
      const blob = await resp.blob();
      dataUrl = await blobToDataUrl(blob);
    }
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

// 汎用保存で対象タブへ順に注入するファイル群（順序が重要）
const GENERIC_INJECT_FILES = [
  'src/vendor/Readability.js',
  'src/vendor/Readability-readerable.js',
  'src/lib/filename.js',
  'src/lib/extractor-generic.js',
  'src/lib/markdown.js',
  'src/content/inject-generic.js',
];

/**
 * 未対応サイト向けの汎用保存。
 * activeTab 権限で対象タブに Readability + 汎用extractor 一式を注入し、
 * inject-generic.js が抽出〜画像fetch(ページ権限)〜SAVE_ARTICLE送信まで行う。
 * その戻り値（保存結果）を呼び出し元に返す。
 * @param {number} tabId
 * @returns {Promise<object>}
 */
async function runGenericSave(tabId) {
  if (!tabId) return { ok: false, error: 'no_tab' };
  if (!chrome.scripting || !chrome.scripting.executeScript) {
    return { ok: false, error: 'scripting_unavailable' };
  }
  try {
    // Readability / lib / extractor を順に注入（最後の inject-generic 以外は戻り値を使わない）
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      files: GENERIC_INJECT_FILES,
    });
    // 最後に実行された inject-generic.js の戻り値（Promise解決値）が保存結果
    const last = Array.isArray(results) ? results[results.length - 1] : null;
    return (last && last.result) || { ok: false, error: 'no_result' };
  } catch (e) {
    console.error('[ArticleSaver] generic save failed', e);
    return { ok: false, error: String(e) };
  }
}

// ---- content / popup からのメッセージを受信 ----
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'SAVE_ARTICLE') {
    runSaveJob(msg.job)
      .then((res) => sendResponse(res))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true; // 非同期応答
  }
  if (msg && msg.type === 'GENERIC_SAVE') {
    runGenericSave(msg.tabId)
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
