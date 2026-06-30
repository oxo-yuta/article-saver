/**
 * content.js
 * Xのページに常駐し、記事ページを検知して「Obsidianに保存」ボタンを注入する。
 * 保存実行時は extractor/markdown で記事を構造化・Markdown化し、
 * background へ保存ジョブ(Markdown本文 + 画像URLリスト + 各パス)を送る。
 *
 * SPA遷移に追従するため MutationObserver で記事ビューの出現を監視する。
 */
(function () {
  'use strict';

  const Extractor = window.ArticleSaverExtractor;
  const Markdown = window.ArticleSaverMarkdown;
  const Filename = window.ArticleSaverFilename;

  const BUTTON_ID = 'obsidian-saver-button';

  // 既定設定（options未設定時のフォールバック）
  const DEFAULT_SETTINGS = {
    vaultDir: 'ObsidianVault',
    noteSubDir: 'Clippings',
    attachmentSubDir: 'Clippings/attachments',
    filenamePattern: '{date}-{slug}',
    tags: ['x-article'],
  };

  /**
   * chrome.storage.sync から設定を読む。
   * @returns {Promise<object>}
   */
  async function loadSettings() {
    try {
      const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
      return { ...DEFAULT_SETTINGS, ...stored };
    } catch (e) {
      return { ...DEFAULT_SETTINGS };
    }
  }

  /**
   * 記事データから保存ジョブを組み立てる。
   * @param {object} settings
   * @returns {null | {markdown:string, mdPath:string, images:Array, title:string}}
   */
  function buildJob(settings) {
    const article = Extractor.extractArticle();
    if (!article) return null;

    const now = new Date();
    const dateStr = Filename.formatDate(now);
    const slug = Filename.slugify(article.title);
    const baseName = Filename.applyPattern(settings.filenamePattern, {
      date: dateStr,
      slug,
      handle: article.handle,
    });

    // 画像の保存パスと Wikilink を割り当てる
    const images = [];
    const wikilinks = article.images.map((img, i) => {
      if (!img.url && !img.id) return null;
      const ext = Filename.imageExt(img.url || '');
      const fileName = `${baseName}-${i + 1}.${ext}`;
      // 添付の保存先（Vault起点の相対パス = DLパス）
      const downloadPath = Filename.joinPath(
        settings.vaultDir,
        settings.attachmentSubDir,
        fileName
      );
      // Obsidian Wikilink本体（Vault内パス = vaultDirを除いた相対）
      const wikilink = Filename.joinPath(settings.attachmentSubDir, fileName);
      images.push({ url: img.url, downloadPath, alt: img.alt || '' });
      return wikilink;
    });

    const markdown = Markdown.buildMarkdown(article, {
      imageWikilinks: wikilinks,
      tags: settings.tags || [],
      savedAt: dateStr,
    });

    const mdPath = Filename.joinPath(
      settings.vaultDir,
      settings.noteSubDir,
      `${baseName}.md`
    );

    return { markdown, mdPath, images, title: article.title };
  }

  /**
   * 保存処理を実行し、ボタンの状態を更新する。
   * @param {HTMLElement} [button]
   */
  async function save(button) {
    const setLabel = (text, state) => {
      if (!button) return;
      button.textContent = text;
      button.dataset.state = state || '';
    };

    try {
      if (!Extractor.isArticlePage()) {
        setLabel('記事が見つかりません', 'error');
        setTimeout(() => resetButton(button), 2500);
        return;
      }

      setLabel('保存中…', 'busy');
      const settings = await loadSettings();
      const job = buildJob(settings);
      if (!job) {
        setLabel('抽出に失敗しました', 'error');
        setTimeout(() => resetButton(button), 2500);
        return;
      }

      const res = await chrome.runtime.sendMessage({ type: 'SAVE_ARTICLE', job });
      if (res && res.ok) {
        const imgInfo = res.imageCount != null ? `（画像${res.imageCount}枚）` : '';
        setLabel(`✓ 保存しました${imgInfo}`, 'done');
      } else {
        setLabel('保存に失敗しました', 'error');
        console.error('[ArticleSaver] save failed:', res && res.error);
      }
      setTimeout(() => resetButton(button), 3000);
    } catch (e) {
      console.error('[ArticleSaver] save error:', e);
      setLabel('エラーが発生しました', 'error');
      setTimeout(() => resetButton(button), 3000);
    }
  }

  function resetButton(button) {
    if (!button) return;
    button.textContent = 'Obsidianに保存';
    button.dataset.state = '';
  }

  /**
   * Xの記事ヘッダー付近に保存ボタンを注入する。
   * 既に存在する場合は何もしない。
   */
  function injectButton() {
    if (!Extractor.isArticlePage()) {
      // 記事ページでなくなったら既存ボタンを除去
      const existing = document.getElementById(BUTTON_ID);
      if (existing) existing.remove();
      return;
    }
    if (document.getElementById(BUTTON_ID)) return;

    const button = document.createElement('button');
    button.id = BUTTON_ID;
    button.type = 'button';
    button.textContent = 'Obsidianに保存';
    button.className = 'obsidian-saver-fab';
    button.title = 'この記事をMarkdownとしてObsidianに保存します';
    button.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      save(button);
    });

    document.body.appendChild(button);
  }

  // ---- background からの保存指示（アイコンクリック経由）に応答 ----
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === 'PING_ARTICLE') {
      sendResponse({ isArticle: Extractor.isArticlePage() });
      return true;
    }
    if (msg && msg.type === 'TRIGGER_SAVE') {
      // popup/アイコンからの実行。ボタンがあれば状態表示も流用
      const button = document.getElementById(BUTTON_ID);
      (async () => {
        try {
          if (!Extractor.isArticlePage()) {
            sendResponse({ ok: false, error: 'not_article' });
            return;
          }
          const settings = await loadSettings();
          const job = buildJob(settings);
          if (!job) {
            sendResponse({ ok: false, error: 'extract_failed' });
            return;
          }
          if (button) {
            button.textContent = '保存中…';
            button.dataset.state = 'busy';
          }
          const res = await chrome.runtime.sendMessage({
            type: 'SAVE_ARTICLE',
            job,
          });
          if (button) {
            button.textContent = res && res.ok ? '✓ 保存しました' : '保存に失敗しました';
            button.dataset.state = res && res.ok ? 'done' : 'error';
            setTimeout(() => resetButton(button), 3000);
          }
          sendResponse(res || { ok: false, error: 'no_response' });
        } catch (e) {
          sendResponse({ ok: false, error: String(e) });
        }
      })();
      return true; // 非同期応答
    }
    return false;
  });

  // ---- SPA遷移に追従して記事ビュー出現を監視 ----
  let scheduled = false;
  const observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    // 連続変化をまとめて処理
    requestAnimationFrame(() => {
      scheduled = false;
      injectButton();
    });
  });

  observer.observe(document.body, { childList: true, subtree: true });

  // 初回
  injectButton();
})();
