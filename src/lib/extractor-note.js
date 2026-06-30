/**
 * extractor-note.js
 * note.com の記事ページのDOMを走査し、
 * 構造化データ { title, author, handle, url, date, blocks[], images[] } を生成する。
 *
 * content script からクラシックスクリプトとして読み込まれるため、
 * グローバル (typeof window!=="undefined"?window:globalThis).ArticleSaverExtractorNote に公開する。
 * サイト振り分けは extractor.js（ディスパッチャ）が行う。
 *
 * Noteは標準的なセマンティックHTML（<h2>/<p>/<ul>/<blockquote>/<figure>/<pre>）で
 * 構成されており、Xに比べて素直に抽出できる。セレクタはこのファイルに集約している。
 */
(function () {
  'use strict';

  // ---- セレクタ定義（NoteのDOM変更で変わったらここを直す）-------------------
  const SEL = {
    // 記事本文コンテナ
    body: '.note-common-styles__textnote-body',
    // 目次（本文から除外する）
    tableOfContents: 'nav.o-tableOfContents',
    // 画像（figure > a > img.is-slide）
    slideImage: 'img.is-slide',
    // コードブロック
    codeBlock: 'div.code-block-container',
  };

  // 画像のホスト（実体ダウンロード対象）
  const IMAGE_HOST_RE = /(^|\.)st-note\.com$/;

  /**
   * 記事ページかどうかを判定する。
   * @returns {boolean}
   */
  function isArticlePage() {
    if (!/(^|\.)note\.com$/.test(location.hostname)) return false;
    return !!document.querySelector(SEL.body);
  }

  /**
   * note の画像URLを正規化する。
   * assets.st-note.com の画像はクエリ無しの素のURLがオリジナル画質なので、
   * 表示用に付与されたサイズ系クエリ(width等)を落とす。
   * @param {string} url
   * @returns {string}
   */
  function normalizeImageUrl(url) {
    if (!url) return url;
    try {
      const u = new URL(url, location.href);
      if (!IMAGE_HOST_RE.test(u.hostname)) return url;
      // サイズ指定のクエリを除去して原寸を得る
      u.search = '';
      return u.toString();
    } catch (e) {
      return url;
    }
  }

  /**
   * 画像の拡張子をURL末尾から推定する（既定 jpg）。
   * @param {string} url
   * @returns {string}
   */
  function guessExt(url) {
    try {
      const u = new URL(url, location.href);
      const m = u.pathname.match(/\.([a-zA-Z0-9]+)$/);
      if (m) {
        const ext = m[1].toLowerCase();
        return ext === 'jpeg' ? 'jpg' : ext;
      }
    } catch (e) {
      /* noop */
    }
    return 'jpg';
  }

  /**
   * 文字列からメディアIDっぽい識別子（パス末尾のファイル名）を抜く。
   * note は明示的なメディアIDを持たないため、重複判定の補助に使う。
   * @param {string} url
   * @returns {string|null}
   */
  function extractMediaId(url) {
    try {
      const u = new URL(url, location.href);
      const m = u.pathname.match(/\/([^/]+?)(?:\.[a-zA-Z0-9]+)?$/);
      return m ? m[1] : null;
    } catch (e) {
      return null;
    }
  }

  /**
   * インライン要素を走査して、太字・斜体・リンクをMarkdown装飾付きテキストに変換する。
   * @param {Element} root
   * @returns {string}
   */
  function inlineText(root) {
    let out = '';

    function walk(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        out += node.nodeValue;
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;

      const el = /** @type {Element} */ (node);
      const tag = el.tagName.toLowerCase();

      // 改行
      if (tag === 'br') {
        out += '\n';
        return;
      }

      // リンク
      if (tag === 'a' && el.getAttribute('href')) {
        const href = el.getAttribute('href');
        const text = (el.textContent || '').trim();
        if (text) out += `[${text}](${href})`;
        return;
      }

      // インラインコード
      if (tag === 'code') {
        const text = (el.textContent || '').trim();
        if (text) out += '`' + text + '`';
        return;
      }

      // 太字 / 斜体
      const style = el.getAttribute('style') || '';
      const weightMatch = style.match(/font-weight:\s*(\d+|bold)/);
      const isBold =
        tag === 'strong' ||
        tag === 'b' ||
        (weightMatch &&
          (weightMatch[1] === 'bold' || parseInt(weightMatch[1], 10) >= 600));
      const isItalic =
        tag === 'em' || tag === 'i' || /font-style:\s*italic/.test(style);

      if (isBold || isItalic) {
        const before = out.length;
        for (const child of el.childNodes) walk(child);
        const inner = out.slice(before);
        const core = inner.trim();
        if (core) {
          out = out.slice(0, before);
          const lead = inner.match(/^\s*/)[0];
          const trail = inner.match(/\s*$/)[0];
          let wrapped = core;
          if (isBold) {
            wrapped = /^\*\*[\s\S]*\*\*$/.test(wrapped)
              ? wrapped
              : `**${wrapped}**`;
          }
          if (isItalic) {
            wrapped = /^\*[\s\S]*\*$/.test(wrapped) ? wrapped : `*${wrapped}*`;
          }
          out += lead + wrapped + trail;
        }
        return;
      }

      for (const child of el.childNodes) walk(child);
    }

    walk(root);
    return out;
  }

  /**
   * テキストを正規化する（NBSP除去・前後空白トリム）。
   * @param {string} s
   * @returns {string}
   */
  function clean(s) {
    return (s || '').replace(/ /g, ' ').replace(/[ \t]+\n/g, '\n').trim();
  }

  /**
   * figure 要素を解析してブロックに変換する。
   * note の figure は (1)画像 (2)Twitter等のembed引用 (3)note記事カード埋め込み のいずれか。
   * @param {Element} fig
   * @param {Array} blocks
   * @param {Array} images
   * @param {Set} seenImageKeys 重複画像防止
   */
  function processFigure(fig, blocks, images, seenImageKeys) {
    // ---- 画像 ----
    const img = fig.querySelector(SEL.slideImage) || fig.querySelector('img');
    if (img) {
      const rawSrc = img.getAttribute('src') || img.src || '';
      const url = normalizeImageUrl(rawSrc);
      if (url) {
        const key = extractMediaId(url) || url;
        if (!seenImageKeys.has(key)) {
          seenImageKeys.add(key);
          const idx = images.length;
          images.push({ id: key, url, alt: img.getAttribute('alt') || '' });
          blocks.push({ type: 'image', imageIndex: idx });
        }
      }
      // キャプション（altが「画像」等の汎用文言なら採用しない）
      const cap = fig.querySelector('figcaption');
      const capText = cap ? clean(cap.textContent) : '';
      if (capText) blocks.push({ type: 'caption', text: capText });
      return;
    }

    // ---- 埋め込み（iframe / blockquote）----
    // figure[data-src] は note記事/外部ページのカード埋め込み。
    const embedUrl =
      fig.getAttribute('data-src') ||
      (fig.querySelector('iframe') &&
        fig.querySelector('iframe').getAttribute('data-src')) ||
      (fig.querySelector('a[href]') &&
        fig.querySelector('a[href]').getAttribute('href')) ||
      '';

    const bq = fig.querySelector('blockquote');
    if (bq && clean(bq.textContent)) {
      // Twitter等の引用埋め込み: 引用文 + 出典リンク
      const quoteText = clean(inlineText(bq));
      if (quoteText) blocks.push({ type: 'quote', text: quoteText });
      const cap = fig.querySelector('figcaption a[href]');
      const link = cap ? cap.getAttribute('href') : embedUrl;
      if (link) blocks.push({ type: 'embed', url: link });
      return;
    }

    // カード埋め込みのみ: リンクとして残す
    if (embedUrl) {
      blocks.push({ type: 'embed', url: embedUrl });
    }
  }

  /**
   * 要素群の class から言語名を推定する。
   * 対応する記法:
   *   - language-xxx / lang-xxx（Prism等の業界標準）
   *   - "hljs xxx"（highlight.js。noteはこの形式 例 "hljs python"）
   * highlight.js が付ける装飾系クラス(hljs等)は言語名から除外する。
   * @param {...Element} els
   * @returns {string} 言語名（無ければ ''）
   */
  function detectCodeLang(...els) {
    // hljsが言語名以外に付ける可能性のあるクラス（言語候補から除外）
    const IGNORE = new Set(['hljs', 'code', 'highlight', 'prettyprint']);
    for (const el of els) {
      if (!el) continue;
      const cls = (el.className || '').toString();
      // 1) language-xxx / lang-xxx
      const m = cls.match(/(?:language|lang)-([\w+#-]+)/i);
      if (m) return m[1].toLowerCase();
      // 2) "hljs xxx" 形式: hljs を含むときだけ、残りのトークンを言語名とみなす
      const tokens = cls.split(/\s+/).filter(Boolean);
      if (tokens.includes('hljs')) {
        const lang = tokens.find((t) => !IGNORE.has(t.toLowerCase()));
        if (lang) return lang.toLowerCase();
      }
    }
    return '';
  }

  /**
   * コードブロック（div.code-block-container > pre）を変換する。
   * @param {Element} container
   * @param {Array} blocks
   */
  function processCodeBlock(container, blocks) {
    const pre = container.querySelector('pre');
    const codeEl = (pre || container).querySelector('code');
    const code = pre ? pre.textContent : container.textContent;
    const text = (code || '').replace(/\n+$/, '');
    if (!text.trim()) return;
    const lang = detectCodeLang(codeEl, pre, container);
    blocks.push({ type: 'code', text, lang });
  }

  /**
   * テーブル（<table>）をGFMテーブル用の行データに変換する。
   * @param {Element} table
   * @param {Array} blocks
   */
  function processTable(table, blocks) {
    const rows = [];
    for (const tr of table.querySelectorAll('tr')) {
      const cells = Array.from(tr.querySelectorAll('th, td')).map((c) =>
        clean(inlineText(c))
      );
      if (cells.length) rows.push(cells);
    }
    if (rows.length) blocks.push({ type: 'table', rows });
  }

  /**
   * リスト（<ul>/<ol>）の各 <li> を個別ブロックに展開する。
   * @param {Element} list
   * @param {Array} blocks
   */
  function processList(list, blocks) {
    const type = list.tagName.toLowerCase() === 'ol' ? 'ol' : 'ul';
    // 直下の li のみ（ネストは将来対応。まず1階層を確実に）
    const items = list.querySelectorAll(':scope > li');
    for (const li of items) {
      const text = clean(inlineText(li));
      if (text) blocks.push({ type, text });
    }
  }

  /**
   * 本文コンテナ直下の1要素を解析して blocks に追加する。
   * @param {Element} el
   * @param {Array} blocks
   * @param {Array} images
   * @param {Set} seenImageKeys
   */
  function processNode(el, blocks, images, seenImageKeys) {
    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    const cls = (el.className || '').toString();

    // 目次はスキップ
    if (tag === 'nav' || cls.includes('o-tableOfContents')) return;

    // 見出し
    if (tag === 'h1' || tag === 'h2') {
      const text = clean(inlineText(el));
      if (text) blocks.push({ type: 'h2', text });
      return;
    }
    if (tag === 'h3' || tag === 'h4') {
      const text = clean(inlineText(el));
      if (text) blocks.push({ type: 'h3', text });
      return;
    }

    // コードブロック
    if (tag === 'div' && cls.includes('code-block-container')) {
      processCodeBlock(el, blocks);
      return;
    }

    // figure（画像 / 埋め込み / 引用）
    if (tag === 'figure') {
      processFigure(el, blocks, images, seenImageKeys);
      return;
    }

    // テーブル
    if (tag === 'table') {
      processTable(el, blocks);
      return;
    }

    // リスト
    if (tag === 'ul' || tag === 'ol') {
      processList(el, blocks);
      return;
    }

    // 引用
    if (tag === 'blockquote') {
      const text = clean(inlineText(el));
      if (text) blocks.push({ type: 'quote', text });
      return;
    }

    // 区切り線
    if (tag === 'hr') {
      blocks.push({ type: 'hr' });
      return;
    }

    // 段落（<p> / 未知ブロック）
    if (tag === 'p' || tag === 'div') {
      // 画像が中に紛れている場合に拾う
      const innerImg = el.querySelector(SEL.slideImage);
      if (innerImg && !el.textContent.trim()) {
        processFigure(el, blocks, images, seenImageKeys);
        return;
      }
      const text = clean(inlineText(el));
      if (text) blocks.push({ type: 'p', text });
      return;
    }

    // その他: テキストがあれば段落扱い
    const text = clean(inlineText(el));
    if (text) blocks.push({ type: 'p', text });
  }

  /**
   * 本文コンテナを走査して、順序を保ったブロック配列を返す。
   * @param {Element} bodyEl
   * @param {Array} images 抽出した画像をここに push する
   * @returns {Array}
   */
  function extractBlocks(bodyEl, images) {
    const blocks = [];
    const seenImageKeys = new Set();
    for (const child of Array.from(bodyEl.children)) {
      processNode(child, blocks, images, seenImageKeys);
    }
    return blocks;
  }

  /**
   * JSON-LD(BlogPosting) からメタ情報を取得する。最も堅牢な情報源。
   * @returns {{title:string, author:string, date:string}}
   */
  function readJsonLd() {
    const result = { title: '', author: '', date: '' };
    const scripts = document.querySelectorAll(
      'script[type="application/ld+json"]'
    );
    for (const script of scripts) {
      let data;
      try {
        data = JSON.parse(script.textContent);
      } catch (e) {
        continue;
      }
      const candidates = Array.isArray(data)
        ? data
        : data['@graph'] || [data];
      for (const d of candidates) {
        if (!d || typeof d !== 'object') continue;
        const type = d['@type'];
        const isPost =
          type === 'BlogPosting' ||
          type === 'Article' ||
          type === 'NewsArticle';
        if (isPost) {
          if (d.headline) result.title = String(d.headline);
          if (d.datePublished) result.date = String(d.datePublished);
          if (d.author) {
            result.author = Array.isArray(d.author)
              ? d.author.map((a) => a && a.name).filter(Boolean).join(', ')
              : d.author.name || String(d.author);
          }
        }
      }
    }
    return result;
  }

  /**
   * メタ情報（著者・ハンドル・日付・タイトル）を取得する。
   * @returns {{title:string, author:string, handle:string, date:string}}
   */
  function extractMeta() {
    const ld = readJsonLd();

    // タイトル: JSON-LD → <h1> → og:title
    let title = ld.title;
    if (!title) {
      const h1 = document.querySelector('h1');
      title = h1 ? clean(h1.textContent) : '';
    }
    if (!title) {
      const og = document.querySelector('meta[property="og:title"]');
      title = og ? (og.content || '').split('｜')[0].trim() : '';
    }

    // 著者: JSON-LD → og:title の「｜」以降
    let author = ld.author;
    if (!author) {
      const og = document.querySelector('meta[property="og:title"]');
      const parts = og ? (og.content || '').split('｜') : [];
      if (parts.length > 1) author = parts[parts.length - 1].trim();
    }

    // ハンドル: URLの urlname（/{urlname}/n/...）
    let handle = '';
    const m = location.pathname.match(/^\/([^/]+)\/n\//);
    if (m) handle = '@' + m[1];

    // 公開日: JSON-LD → <time datetime>
    let date = ld.date;
    if (!date) {
      const timeEl = document.querySelector('time[datetime]');
      if (timeEl) date = timeEl.getAttribute('datetime') || '';
    }

    return { title: title || '無題の記事', author, handle, date };
  }

  /**
   * ページ全体から記事データを抽出するエントリポイント。
   * @returns {null | {title, author, handle, url, date, blocks, images}}
   */
  function extractArticle() {
    if (!isArticlePage()) return null;

    const bodyEl = document.querySelector(SEL.body);
    if (!bodyEl) return null;

    const meta = extractMeta();
    const images = [];
    const blocks = extractBlocks(bodyEl, images);

    return {
      title: meta.title,
      author: meta.author,
      handle: meta.handle,
      url: location.href.split('?')[0],
      date: meta.date,
      blocks,
      images,
    };
  }

  (typeof window !== 'undefined' ? window : globalThis).ArticleSaverExtractorNote = {
    isArticlePage,
    extractArticle,
    normalizeImageUrl,
  };
})();
