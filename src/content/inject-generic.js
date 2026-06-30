/**
 * inject-generic.js
 * popup → background 経由で、未対応サイトのページに動的注入されるスクリプト。
 * （chrome.scripting.executeScript の files: で、Readability / extractor-generic /
 *   filename / markdown を先に注入した後に、このファイルが実行される）
 *
 * 役割:
 *  - 汎用extractor(Readability)で本文を構造化
 *  - 画像を「このページのコンテキスト」でfetchしてdataURL化する
 *    （ページ権限でfetchするため、拡張に広範な host_permissions が不要）
 *  - 保存ジョブ(Markdown + 画像dataURL + パス)を background に送信
 *
 * 専用サイト(X/note)の常駐 content.js とは独立した実行経路。
 * 結果は最後の式（Promise解決値）として executeScript の呼び出し元へ返る。
 */
(async function () {
  'use strict';

  const Extractor = window.ArticleSaverExtractorGeneric;
  const Markdown = window.ArticleSaverMarkdown;
  const Filename = window.ArticleSaverFilename;

  const DEFAULT_SETTINGS = {
    vaultDir: 'ObsidianVault',
    noteSubDir: 'Clippings',
    attachmentSubDir: 'Clippings/attachments',
    filenamePattern: '{date}-{slug}',
    tags: ['clipped'],
  };

  if (!Extractor || !Markdown || !Filename) {
    return { ok: false, error: 'dependencies_not_loaded' };
  }

  async function loadSettings() {
    try {
      const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
      return { ...DEFAULT_SETTINGS, ...stored };
    } catch (e) {
      return { ...DEFAULT_SETTINGS };
    }
  }

  /**
   * Blob を data: URL に変換する。
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
   * URLから拡張子を推定する（既定 jpg）。
   * @param {string} url
   * @returns {string}
   */
  function imageExt(url) {
    try {
      const u = new URL(url, location.href);
      const m = u.pathname.match(/\.([a-zA-Z0-9]+)$/);
      if (m) {
        const e = m[1].toLowerCase();
        return e === 'jpeg' ? 'jpg' : e;
      }
    } catch (e) {
      /* noop */
    }
    return 'jpg';
  }

  try {
    if (!Extractor.isArticlePage()) {
      return { ok: false, error: 'not_article' };
    }

    const article = Extractor.extractArticle();
    if (!article) return { ok: false, error: 'extract_failed' };

    const settings = await loadSettings();
    const now = new Date();
    const dateStr = Filename.formatDate(now);
    const slug = Filename.slugify(article.title);
    const baseName = Filename.applyPattern(settings.filenamePattern, {
      date: dateStr,
      slug,
      handle: article.handle,
    });

    // 画像をページコンテキストでfetchしてdataURL化する
    const images = [];
    const wikilinks = [];
    for (let i = 0; i < article.images.length; i++) {
      const img = article.images[i];
      if (!img || !img.url) {
        wikilinks.push(null);
        continue;
      }
      const ext = imageExt(img.url);
      const fileName = `${baseName}-${i + 1}.${ext}`;
      const downloadPath = Filename.joinPath(
        settings.vaultDir,
        settings.attachmentSubDir,
        fileName
      );
      const wikilink = Filename.joinPath(settings.attachmentSubDir, fileName);

      let dataUrl = null;
      try {
        const resp = await fetch(img.url, { credentials: 'omit' });
        if (resp.ok) {
          const blob = await resp.blob();
          dataUrl = await blobToDataUrl(blob);
        }
      } catch (e) {
        // 取得失敗時は dataUrl 無し → Markdown側で元URLにフォールバック
      }

      if (dataUrl) {
        images.push({ dataUrl, downloadPath, url: img.url, alt: img.alt || '' });
        wikilinks.push(wikilink);
      } else {
        // 失敗: 画像は保存せず、Markdownは元URL参照のまま
        wikilinks.push(null);
      }
    }

    // 保存元タグ
    const tags = Array.isArray(settings.tags) ? settings.tags.slice() : [];
    if (!tags.includes('web-clip')) tags.push('web-clip');

    const markdown = Markdown.buildMarkdown(article, {
      imageWikilinks: wikilinks,
      tags,
      savedAt: dateStr,
    });

    const mdPath = Filename.joinPath(
      settings.vaultDir,
      settings.noteSubDir,
      `${baseName}.md`
    );

    const job = { markdown, mdPath, images, title: article.title };
    const res = await chrome.runtime.sendMessage({ type: 'SAVE_ARTICLE', job });
    return res || { ok: false, error: 'no_response' };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
})();
