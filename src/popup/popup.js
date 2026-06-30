/**
 * popup.js
 * ポップアップUIの制御。アクティブタブが記事ページか確認し、
 * 保存ボタンで content に TRIGGER_SAVE を送る。
 */
(function () {
  'use strict';

  const statusEl = document.getElementById('status');
  const saveBtn = document.getElementById('saveBtn');
  const optionsLink = document.getElementById('optionsLink');

  function setStatus(text, cls) {
    statusEl.textContent = text;
    statusEl.className = cls || '';
  }

  /**
   * アクティブタブを取得する。
   * @returns {Promise<chrome.tabs.Tab|null>}
   */
  async function getActiveTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs && tabs[0] ? tabs[0] : null;
  }

  let activeTabId = null;

  async function init() {
    const tab = await getActiveTab();
    if (!tab || !tab.id) {
      setStatus('タブを取得できませんでした', 'error');
      return;
    }
    activeTabId = tab.id;

    const url = tab.url || '';
    if (!/^https:\/\/((x|twitter)\.com|note\.com)\//.test(url)) {
      setStatus('X・noteのページではありません', 'error');
      return;
    }

    // content に記事ページか問い合わせる
    try {
      const res = await chrome.tabs.sendMessage(tab.id, { type: 'PING_ARTICLE' });
      if (res && res.isArticle) {
        setStatus('記事ページを検出しました', 'ok');
        saveBtn.disabled = false;
      } else {
        setStatus('記事ページではありません', 'error');
      }
    } catch (e) {
      // content scriptがまだ読み込まれていない等
      setStatus('このページでは利用できません', 'error');
    }
  }

  saveBtn.addEventListener('click', async () => {
    if (!activeTabId) return;
    saveBtn.disabled = true;
    setStatus('保存中…', '');
    try {
      const res = await chrome.tabs.sendMessage(activeTabId, {
        type: 'TRIGGER_SAVE',
      });
      if (res && res.ok) {
        const n = res.imageCount != null ? `（画像${res.imageCount}枚）` : '';
        setStatus(`✓ 保存しました${n}`, 'ok');
      } else {
        const reason =
          res && res.error === 'not_article'
            ? '記事ページではありません'
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
