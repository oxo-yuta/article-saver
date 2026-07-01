/**
 * extractor-generic.js
 * 専用extractorが無い任意のWebページから、Mozilla Readability で本文を抽出し、
 * 構造化データ { title, author, handle, url, date, blocks[], images[] } を生成する。
 *
 * 専用サイト(X/note/...)では使わず、ディスパッチャ(extractor.js)が
 * どのサイトにもマッチしなかった場合のフォールバックとして用いる。
 * このスクリプトは通常ページには常駐させず、popup から activeTab 権限で
 * 動的注入(chrome.scripting.executeScript)して使う想定。
 *
 * 依存: window.Readability / window.isProbablyReaderable
 *   （manifest または executeScript で Readability.js を先に読み込むこと）
 *
 * グローバル (typeof window!=="undefined"?window:globalThis).ArticleSaverExtractorGeneric に公開する。
 */
(function () {
  'use strict';

  /**
   * Readability が利用可能か。
   * @returns {boolean}
   */
  function hasReadability() {
    return typeof window !== 'undefined' && typeof window.Readability === 'function';
  }

  /**
   * このページが「記事として抽出する価値がある」かを判定する。
   * Readability の isProbablyReaderable を使い、無ければ本文量で簡易判定する。
   * @returns {boolean}
   */
  function isArticlePage() {
    if (!hasReadability()) return false;
    try {
      if (typeof window.isProbablyReaderable === 'function') {
        return window.isProbablyReaderable(document);
      }
    } catch (e) {
      /* フォールバックへ */
    }
    // フォールバック: 本文テキスト量で判定
    const text = (document.body && document.body.innerText) || '';
    return text.replace(/\s+/g, '').length > 500;
  }

  /**
   * 画像/リンクの相対URLを絶対URLに正規化する。
   * @param {string} url
   * @param {string} base
   * @returns {string}
   */
  function absoluteUrl(url, base) {
    if (!url) return url;
    try {
      return new URL(url, base || location.href).toString();
    } catch (e) {
      return url;
    }
  }

  /**
   * 画像URLは抽出実装ごとに正規化方針が異なるが、generic は絶対URL化のみ行う。
   * @param {string} url
   * @returns {string}
   */
  function normalizeImageUrl(url) {
    return absoluteUrl(url, location.href);
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
   * インライン要素を走査して、太字・斜体・リンク・コードをMarkdown装飾付きテキストに変換する。
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

      if (tag === 'br') {
        out += '\n';
        return;
      }
      if (tag === 'a' && el.getAttribute('href')) {
        const href = absoluteUrl(el.getAttribute('href'), location.href);
        const text = (el.textContent || '').trim();
        if (text) out += `[${text}](${href})`;
        return;
      }
      if (tag === 'code') {
        const text = (el.textContent || '').trim();
        if (text) out += '`' + text + '`';
        return;
      }

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
            wrapped = /^\*\*[\s\S]*\*\*$/.test(wrapped) ? wrapped : `**${wrapped}**`;
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

  function clean(s) {
    return (s || '').replace(/ /g, ' ').replace(/[ \t]+\n/g, '\n').trim();
  }

  /**
   * pre/code の class から言語名を推定する（language-xxx / lang-xxx / "hljs xxx"）。
   * @param {...Element} els
   * @returns {string}
   */
  function detectCodeLang(...els) {
    const IGNORE = new Set(['hljs', 'code', 'highlight', 'prettyprint', 'source']);
    for (const el of els) {
      if (!el) continue;
      const cls = (el.className || '').toString();
      const m = cls.match(/(?:language|lang)-([\w+#-]+)/i);
      if (m) return m[1].toLowerCase();
      const tokens = cls.split(/\s+/).filter(Boolean);
      if (tokens.includes('hljs')) {
        const lang = tokens.find((t) => !IGNORE.has(t.toLowerCase()));
        if (lang) return lang.toLowerCase();
      }
    }
    return '';
  }

  // 明らかにコンテンツ画像でないもの（アイコン/SNSボタン/アバター/計測画素等）。
  // 誤検知を避けるため、区切り文字(先頭/末尾/ - _ . /)で囲まれた語としてのみ一致させる。
  // （例: "shared" を "share" で誤爆しない）
  const NOISE_TOKENS = [
    'avatar', 'icon', 'icons', 'logo', 'emoji', 'sprite', 'spacer', 'blank',
    'pixel', '1x1', 'badge', 'share', 'sns', 'hatena', 'feedly', 'rss',
    'banner', 'tracking', 'beacon', 'gravatar',
  ];
  const NOISE_URL_RE = new RegExp(
    '(?:^|[/_.-])(' + NOISE_TOKENS.join('|') + ')(?:$|[/_.-])',
    'i'
  );

  /**
   * 画像がコンテンツとして保存する価値が無いノイズか判定する。
   * @param {Element} img
   * @param {string} url
   * @returns {boolean}
   */
  function isNoiseImage(img, url) {
    // クエリを除いたパス部分だけで判定（クエリ内の無関係な語を誤爆しない）
    let path = url;
    try {
      path = new URL(url, location.href).pathname;
    } catch (e) {
      /* URLでなければそのまま */
    }
    if (NOISE_URL_RE.test(path)) return true;
    // width/height 属性が明示的に小さいものはアイコン類とみなす
    const w = parseInt(img.getAttribute('width') || '', 10);
    const h = parseInt(img.getAttribute('height') || '', 10);
    if (w && w < 80) return true;
    if (h && h < 80) return true;
    return false;
  }

  /**
   * 画像要素から保存対象の画像を取り出す。ノイズ画像は除外する。
   * @param {Element} img
   * @param {Array} images
   * @param {Set} seen
   * @returns {number|null} imageIndex
   */
  function pushImage(img, images, seen) {
    // lazy-load対策で data-src 系も見る
    const raw =
      img.getAttribute('src') ||
      img.getAttribute('data-src') ||
      img.getAttribute('data-original') ||
      img.getAttribute('data-lazy-src') ||
      '';
    const url = absoluteUrl(raw, location.href);
    if (!url || /^data:/.test(url)) return null;
    if (seen.has(url)) return null;
    if (isNoiseImage(img, url)) return null;
    seen.add(url);
    const idx = images.length;
    images.push({ id: url, url, alt: img.getAttribute('alt') || '' });
    return idx;
  }

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

  function processList(list, blocks) {
    const type = list.tagName.toLowerCase() === 'ol' ? 'ol' : 'ul';
    for (const li of list.querySelectorAll(':scope > li')) {
      const text = clean(inlineText(li));
      if (text) blocks.push({ type, text });
    }
  }

  /**
   * 1要素を解析して blocks に追加する（再帰的に子も処理）。
   * @param {Element} el
   * @param {Array} blocks
   * @param {Array} images
   * @param {Set} seen
   */
  function processNode(el, blocks, images, seen) {
    const tag = el.tagName ? el.tagName.toLowerCase() : '';

    switch (tag) {
      case 'h1':
      case 'h2': {
        const t = clean(inlineText(el));
        if (t) blocks.push({ type: 'h2', text: t });
        return;
      }
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6': {
        const t = clean(inlineText(el));
        if (t) blocks.push({ type: 'h3', text: t });
        return;
      }
      case 'pre': {
        const codeEl = el.querySelector('code');
        const text = (el.textContent || '').replace(/\n+$/, '');
        if (text.trim()) {
          blocks.push({ type: 'code', text, lang: detectCodeLang(codeEl, el) });
        }
        return;
      }
      case 'blockquote': {
        const t = clean(inlineText(el));
        if (t) blocks.push({ type: 'quote', text: t });
        return;
      }
      case 'ul':
      case 'ol':
        processList(el, blocks);
        return;
      case 'table':
        processTable(el, blocks);
        return;
      case 'hr':
        blocks.push({ type: 'hr' });
        return;
      case 'div':
      case 'section':
      case 'article':
      case 'main':
      case 'aside': {
        // コンテナ系: ブロックレベルの子を持つなら再帰して構造を保つ。
        // 持たなければ（テキスト/インラインのみなら）1つの段落として扱う。
        if (hasBlockChildren(el)) {
          for (const child of Array.from(el.children)) {
            processNode(child, blocks, images, seen);
          }
          return;
        }
        // ブロック子が無いが画像だけ持つコンテナ
        const innerImgs = el.querySelectorAll(':scope img, :scope picture img');
        if (innerImgs.length) {
          for (const img of innerImgs) {
            const idx = pushImage(img, images, seen);
            if (idx != null) blocks.push({ type: 'image', imageIndex: idx });
          }
        }
        const ct = clean(inlineText(el));
        if (ct) blocks.push({ type: 'p', text: ct });
        return;
      }
      case 'figure': {
        // 画像を出し、figcaption はキャプションに
        const figImgs = el.querySelectorAll(':scope img, :scope picture img');
        for (const img of figImgs) {
          const idx = pushImage(img, images, seen);
          if (idx != null) blocks.push({ type: 'image', imageIndex: idx });
        }
        const cap = el.querySelector('figcaption');
        const capText = cap ? clean(inlineText(cap)) : '';
        if (capText) blocks.push({ type: 'caption', text: capText });
        return;
      }
      case 'p': {
        // 段落中の画像も拾う
        const pImgs = el.querySelectorAll(':scope img, :scope picture img');
        for (const img of pImgs) {
          const idx = pushImage(img, images, seen);
          if (idx != null) blocks.push({ type: 'image', imageIndex: idx });
        }
        const t = clean(inlineText(el));
        if (t) blocks.push({ type: 'p', text: t });
        return;
      }
      case 'img': {
        const idx = pushImage(el, images, seen);
        if (idx != null) blocks.push({ type: 'image', imageIndex: idx });
        return;
      }
      default: {
        const t = clean(inlineText(el));
        if (t) blocks.push({ type: 'p', text: t });
        return;
      }
    }
  }

  /**
   * 要素がブロックレベルの子要素を持つか（段落として一括処理すべきでないか）。
   * @param {Element} el
   * @returns {boolean}
   */
  function hasBlockChildren(el) {
    return !!el.querySelector(
      ':scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6, ' +
        ':scope > p, :scope > ul, :scope > ol, :scope > pre, :scope > blockquote, ' +
        ':scope > table, :scope > figure, :scope > hr, :scope > div, :scope > section, ' +
        ':scope > article, :scope > main, :scope > aside'
    );
  }

  /**
   * Readability の出力HTMLをDOM化して、ブロック配列に変換する。
   *
   * セキュリティ: DOMParser でパースした文書は現在のページから切り離されており、
   * スクリプトは実行されず、リソース(画像等)の即時取得も発生しない。
   * （innerHTML 代入と異なり img の先読みリクエストも飛ばない）
   * Readability の出力は元々サニタイズ済みだが、二重に安全側へ倒す。
   * @param {string} html
   * @param {Array} images
   * @returns {Array}
   */
  function extractBlocks(html, images) {
    const blocks = [];
    const seen = new Set();
    const doc = new DOMParser().parseFromString(html || '', 'text/html');
    // Readability は <div id="readability-page-1"> でラップするので、あれば内側を使う
    const root =
      doc.body.querySelector('[id^="readability-page"]') || doc.body;
    for (const child of Array.from(root.children)) {
      processNode(child, blocks, images, seen);
    }
    return blocks;
  }

  /**
   * og:image / twitter:image からアイキャッチ画像URLを取得する。
   * @returns {string} 絶対URL（無ければ ''）
   */
  function getLeadImageUrl() {
    const sel = [
      'meta[property="og:image:secure_url"]',
      'meta[property="og:image"]',
      'meta[name="twitter:image"]',
      'meta[name="twitter:image:src"]',
    ];
    for (const s of sel) {
      const m = document.querySelector(s);
      const c = m && (m.getAttribute('content') || '');
      if (c) return absoluteUrl(c, location.href);
    }
    return '';
  }

  /**
   * 元ページの本文コンテナを推定する（Readabilityが画像を落とした際の補完元）。
   * @returns {Element|null}
   */
  function findContentContainer() {
    const article = document.querySelector('article');
    const scope = article || document.querySelector('main') || document.body;
    // 段落を多く含む子孫を本文とみなす
    const candidates = Array.from(scope.querySelectorAll('div, section, article')).filter(
      (el) => el.querySelectorAll(':scope > p').length >= 3
    );
    if (!candidates.length) return article || scope;
    return candidates.sort(
      (a, b) =>
        b.querySelectorAll(':scope > p, :scope > figure, :scope img').length -
        a.querySelectorAll(':scope > p, :scope > figure, :scope img').length
    )[0];
  }

  /**
   * ページ全体から記事データを抽出するエントリポイント。
   * @returns {null | object}
   */
  function extractArticle() {
    if (!hasReadability()) return null;

    let result;
    try {
      // Readability は document を破壊的に変更するため必ず複製を渡す
      const docClone = document.cloneNode(true);
      result = new window.Readability(docClone, {
        charThreshold: 200,
      }).parse();
    } catch (e) {
      return null;
    }
    if (!result) return null;

    const images = [];
    const blocks = extractBlocks(result.content || '', images);
    const seen = new Set(images.map((im) => im.url));

    // --- アイキャッチ(og:image)を先頭画像として追加 ---
    const lead = getLeadImageUrl();
    if (lead && !seen.has(lead) && !isNoiseImage({ getAttribute: () => null }, lead)) {
      seen.add(lead);
      images.unshift({ id: lead, url: lead, alt: '' });
      // blocks の全 imageIndex を +1 ずらし、先頭に画像ブロックを差し込む
      for (const b of blocks) {
        if (b.type === 'image') b.imageIndex += 1;
      }
      blocks.unshift({ type: 'image', imageIndex: 0 });
    }

    // --- 本文画像の補完: Readabilityが本文画像をほとんど拾えなかった場合、
    //     元DOMの本文コンテナから有効画像を末尾に補う（順序は完全一致しない） ---
    const bodyImageCount = images.length - (lead ? 1 : 0);
    if (bodyImageCount < 1) {
      const container = findContentContainer();
      if (container) {
        for (const img of container.querySelectorAll('img')) {
          const idx = pushImage(img, images, seen);
          if (idx != null) blocks.push({ type: 'image', imageIndex: idx });
        }
      }
    }

    // ハンドル: ページ著者が取れなければ空
    const handle = '';

    return {
      title: (result.title || document.title || '無題の記事').trim(),
      author: result.byline || '',
      handle,
      url: location.href.split('#')[0],
      date: result.publishedTime || '',
      blocks,
      images,
    };
  }

  (typeof window !== 'undefined' ? window : globalThis).ArticleSaverExtractorGeneric = {
    isArticlePage,
    extractArticle,
    normalizeImageUrl,
  };
})();
