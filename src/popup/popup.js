/**
 * popup.js
 * ポップアップUIの制御。
 *  - 専用サイト(X/note)では content に PING/TRIGGER_SAVE を送って保存
 *  - それ以外の http(s) ページでは「汎用保存」を有効化し、
 *    background に GENERIC_SAVE を送って Readability ベースで保存する
 */
(function () {
  'use strict';

  const statusEl = document.getElementById('status');
  const saveBtn = document.getElementById('saveBtn');
  const optionsLink = document.getElementById('optionsLink');

  // 専用extractorを持つサイト
  const DEDICATED_RE = /^https:\/\/((x|twitter)\.com|note\.com)\//;

  let activeTabId = null;
  let mode = null; // 'dedicated' | 'generic'

  function setStatus(text, cls) {
    statusEl.textContent = text;
    statusEl.className = cls || '';
  }

  async function getActiveTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs && tabs[0] ? tabs[0] : null;
  }

  async function init() {
    const tab = await getActiveTab();
    if (!tab || !tab.id) {
      setStatus('タブを取得できませんでした', 'error');
      return;
    }
    activeTabId = tab.id;
    const url = tab.url || '';

    if (DEDICATED_RE.test(url)) {
      // 専用サイト: content に記事ページか問い合わせる
      mode = 'dedicated';
      try {
        const res = await chrome.tabs.sendMessage(tab.id, { type: 'PING_ARTICLE' });
        if (res && res.isArticle) {
          setStatus('記事ページを検出しました', 'ok');
          saveBtn.disabled = false;
        } else {
          setStatus('記事ページではありません', 'error');
        }
      } catch (e) {
        setStatus('このページでは利用できません', 'error');
      }
      return;
    }

    if (/^https?:\/\//.test(url)) {
      // 未対応サイト: 汎用保存を提案
      mode = 'generic';
      setStatus('このページを汎用モードで保存できます', 'ok');
      saveBtn.textContent = 'このページを保存';
      saveBtn.disabled = false;
      return;
    }

    // chrome:// など保存不可
    setStatus('このページは保存できません', 'error');
  }

  async function saveDedicated() {
    const res = await chrome.tabs.sendMessage(activeTabId, { type: 'TRIGGER_SAVE' });
    return res;
  }

  async function saveGeneric() {
    const res = await chrome.runtime.sendMessage({
      type: 'GENERIC_SAVE',
      tabId: activeTabId,
    });
    return res;
  }

  saveBtn.addEventListener('click', async () => {
    if (!activeTabId || !mode) return;
    saveBtn.disabled = true;
    setStatus('保存中…', '');
    try {
      const res = mode === 'generic' ? await saveGeneric() : await saveDedicated();
      if (res && res.ok) {
        const n = res.imageCount != null ? `（画像${res.imageCount}枚）` : '';
        setStatus(`✓ 保存しました${n}`, 'ok');
      } else {
        const reason =
          res && res.error === 'not_article'
            ? '記事として抽出できませんでした'
            : '保存に失敗しました';
        setStatus(reason, 'error');
        saveBtn.disabled = false;
      }
    } catch (e) {
      setStatus('保存に失敗しました', 'error');
      saveBtn.disabled = false;
    }
  });

  optionsLink.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  init();
})();
