/**
 * extractor-x.js
 * Xの記事(longform / Articles)ページのDOMを走査し、
 * 構造化データ { title, author, handle, url, date, blocks[], images[] } を生成する。
 *
 * content script からクラシックスクリプトとして読み込まれるため、
 * グローバル (typeof window!=="undefined"?window:globalThis).ArticleSaverExtractorX に公開する。
 * サイト振り分けは extractor.js（ディスパッチャ）が行う。
 *
 * セレクタはXのDOM変更で壊れやすいので、このファイルに集約している。
 */
(function () {
  'use strict';

  // ---- セレクタ定義（Xのアップデートで変わったらここを直す）-------------------
  const SEL = {
    readView: '[data-testid="twitterArticleReadView"]',
    title: '[data-testid="twitter-article-title"]',
    body: '[data-testid="longformRichTextComponent"]',
    // 本文ブロック種別
    headerOne: 'longform-header-one',
    headerTwo: 'longform-header-two',
    unstyled: 'longform-unstyled',
    blockquote: 'longform-blockquote',
    listItemUnordered: 'longform-unordered-list-item',
    listItemOrdered: 'longform-ordered-list-item',
    // 画像
    tweetPhoto: '[data-testid="tweetPhoto"]',
    // 著者情報
    userName: '[data-testid="User-Name"]',
  };

  /**
   * 記事ページかどうかを判定する。
   * @returns {boolean}
   */
  function isArticlePage() {
    return !!document.querySelector(SEL.readView);
  }

  /**
   * pbs.twimg.com の画像URLを最高画質(orig)に正規化する。
   * 例: .../media/AbcdEfgh?format=jpg&name=small -> ...&name=orig
   * @param {string} url
   * @returns {string}
   */
  function normalizeImageUrl(url) {
    if (!url) return url;
    try {
      const u = new URL(url, location.href);
      if (!/pbs\.twimg\.com$/.test(u.hostname)) return url;
      // format が無ければ jpg を補う
      if (!u.searchParams.get('format')) u.searchParams.set('format', 'jpg');
      u.searchParams.set('name', 'orig');
      return u.toString();
    } catch (e) {
      return url;
    }
  }

  /**
   * 文字列からメディアID(例 /media/AbcdEfgh)を抜き出す。
   * @param {string} s
   * @returns {string|null}
   */
  function extractMediaId(s) {
    if (!s) return null;
    const m = s.match(/\/media\/([A-Za-z0-9_-]+)/);
    return m ? m[1] : null;
  }

  /**
   * tweetPhoto 要素から画像URLとメディアIDを取得する。
   * src属性が CDN URL でない（保存版HTMLやblob）場合に備え、
   * 内部の background-image / a[href] からもフォールバックで拾う。
   * @param {Element} photoEl
   * @returns {{id:string|null, url:string|null, alt:string}}
   */
  function readPhoto(photoEl) {
    let url = null;
    let id = null;
    let alt = '';

    const img = photoEl.querySelector('img');
    if (img) {
      alt = img.getAttribute('alt') || '';
      const src = img.getAttribute('src') || '';
      if (/pbs\.twimg\.com\/media\//.test(src)) {
        url = src;
        id = extractMediaId(src);
      }
    }

    // フォールバック1: background-image url(...) を持つ要素
    if (!url) {
      const bgEl = photoEl.querySelector('[style*="background-image"]');
      if (bgEl) {
        const style = bgEl.getAttribute('style') || '';
        const m = style.match(/url\(["']?(https:\/\/pbs\.twimg\.com\/media\/[^"')]+)["']?\)/);
        if (m) {
          url = m[1].replace(/&amp;/g, '&');
          id = extractMediaId(url);
        }
      }
    }

    // フォールバック2: 祖先/近傍の a[href*="/media/"] からID
    if (!id) {
      const a =
        photoEl.closest('a[href*="/media/"]') ||
        photoEl.querySelector('a[href*="/media/"]') ||
        (photoEl.parentElement &&
          photoEl.parentElement.querySelector('a[href*="/media/"]'));
      if (a) id = extractMediaId(a.getAttribute('href') || '');
    }

    // URLが取れていてIDが空ならURLから補完
    if (url && !id) id = extractMediaId(url);
    // IDからURLを合成（URL未取得時）
    if (!url && id) url = `https://pbs.twimg.com/media/${id}?format=jpg&name=orig`;

    return { id, url: url ? normalizeImageUrl(url) : null, alt };
  }

  /**
   * インライン要素を走査して、太字・リンクをMarkdown装飾付きテキストに変換する。
   * Draft.js では装飾は span のネスト/スタイルで表現されるため、
   * 取りこぼしを避けつつ最低限の装飾を拾う。
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

      // リンク
      if (tag === 'a' && el.getAttribute('href')) {
        const href = el.getAttribute('href');
        const text = (el.textContent || '').trim();
        if (text) out += `[${text}](${href})`;
        return;
      }

      // 太字判定（strong/b、もしくは font-weight が太い）
      const style = el.getAttribute('style') || '';
      const weightMatch = style.match(/font-weight:\s*(\d+|bold)/);
      const isBold =
        tag === 'strong' ||
        tag === 'b' ||
        (weightMatch &&
          (weightMatch[1] === 'bold' || parseInt(weightMatch[1], 10) >= 600));
      const isItalic = tag === 'em' || tag === 'i' || /font-style:\s*italic/.test(style);

      if (isBold || isItalic) {
        const before = out.length;
        for (const child of el.childNodes) walk(child);
        const inner = out.slice(before);
        const core = inner.trim();
        if (core) {
          out = out.slice(0, before);
          // 前後のスペースは装飾の外側に出す（** の隣接に空白を入れない）
          const lead = inner.match(/^\s*/)[0];
          const trail = inner.match(/\s*$/)[0];

          let wrapped = core;
          // 子要素で既に同種マーカーが付いている場合は二重に巻かない（ネスト対策）
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
   * 見出しブロックのMarkdownレベルを判定する。
   *
   * Xの記事では見出しが2系統あるため、両対応する:
   *   1) Draft.jsの longform-header-one / -two クラス
   *   2) ブロック内に実体の <h1>/<h2> を持つ新しい形式（clsはcss-*でヒントが無い）
   * いずれも取れない場合は内部要素の font-size から推定する。
   *
   * 戻り値は記事本文の見出しレベル('h2' | 'h3')。
   * 記事タイトルが Markdown の # なので、本文の最上位見出しは ## (=h2) から始める。
   *
   * @param {Element} block ブロック要素
   * @returns {('h2'|'h3'|null)} 見出しでなければ null
   */
  function detectHeadingLevel(block) {
    const cls = (block.className || '').toString();

    // 1) longform-header-* クラス（旧来形式）
    if (cls.includes(SEL.headerOne)) return 'h2';
    if (cls.includes(SEL.headerTwo)) return 'h3';

    // 2) 内部の実体見出しタグ
    const hEl = block.querySelector('h1, h2, h3, [role="heading"]');
    if (hEl) {
      const tag = hEl.tagName.toLowerCase();
      if (tag === 'h1') return 'h2';
      if (tag === 'h2') return 'h3';
      if (tag === 'h3') return 'h3';
      // role="heading" の場合は aria-level を見る
      const lvl = parseInt(hEl.getAttribute('aria-level') || '', 10);
      if (lvl === 1) return 'h2';
      if (lvl >= 2) return 'h3';
      // 3) フォールバック: font-size で大小を判定（h1≈31px / h2≈26px）
      try {
        const fs = parseFloat(getComputedStyle(hEl).fontSize) || 0;
        if (fs >= 29) return 'h2';
        if (fs >= 22) return 'h3';
      } catch (e) {
        /* getComputedStyle不可環境では無視 */
      }
      // 見出しタグはあるがレベル不明 → h3 扱い
      return 'h3';
    }

    return null;
  }

  /**
   * 1ブロックを解析して blocks に追加する。
   * リスト(<ol>/<ul>)は内部の各 <li> を個別ブロックに展開する。
   *
   * @param {Element} child ブロック要素
   * @param {Array} blocks 出力先
   * @param {Array} images 画像出力先
   * @param {WeakSet} seenPhotos 重複画像防止
   */
  function processBlock(child, blocks, images, seenPhotos) {
    const cls = (child.className || '').toString();
    const tag = child.tagName ? child.tagName.toLowerCase() : '';

    // ---- 画像セクション（contenteditable=false の section） ----
    const photos = child.querySelectorAll(SEL.tweetPhoto);
    if (photos.length) {
      for (const photo of photos) {
        if (seenPhotos.has(photo)) continue;
        seenPhotos.add(photo);
        const info = readPhoto(photo);
        if (info.url || info.id) {
          const idx = images.length;
          images.push(info);
          blocks.push({ type: 'image', imageIndex: idx });
        }
      }
      // 画像セクションに本文テキストブロックが無ければ終了
      if (!/longform-/.test(cls) && tag !== 'li') return;
    }

    // ---- リスト（<ol> / <ul>）: 各 <li> を個別に展開 ----
    if (tag === 'ol' || tag === 'ul') {
      const items = child.querySelectorAll('li');
      for (const li of items) {
        const liRoot =
          li.querySelector('.public-DraftStyleDefault-block') || li;
        const text = inlineText(liRoot).replace(/ /g, ' ').trim();
        if (text) blocks.push({ type: tag === 'ol' ? 'ol' : 'ul', text });
      }
      return;
    }

    // ---- 見出し（クラス or 内部 h1/h2 で判定） ----
    const headingLevel = detectHeadingLevel(child);
    if (headingLevel) {
      const hRoot =
        child.querySelector('[role="heading"], h1, h2, h3') ||
        child.querySelector('.public-DraftStyleDefault-block') ||
        child;
      let text = inlineText(hRoot).replace(/ /g, ' ').trim();
      // 見出し全体が太字/斜体マーカーで囲まれている場合は剥がす（### **x** の重複防止）
      text = text
        .replace(/^\*\*([\s\S]*)\*\*$/, '$1')
        .replace(/^\*([\s\S]*)\*$/, '$1')
        .trim();
      if (text) blocks.push({ type: headingLevel, text });
      return;
    }

    // ---- 引用 ----
    if (cls.includes(SEL.blockquote)) {
      const text = inlineText(child).replace(/ /g, ' ').trim();
      if (text) blocks.push({ type: 'quote', text });
      return;
    }

    // ---- リスト項目が単独で子になっている場合（保険） ----
    if (cls.includes(SEL.listItemUnordered)) {
      const text = inlineText(child).replace(/ /g, ' ').trim();
      if (text) blocks.push({ type: 'ul', text });
      return;
    }
    if (cls.includes(SEL.listItemOrdered)) {
      const text = inlineText(child).replace(/ /g, ' ').trim();
      if (text) blocks.push({ type: 'ol', text });
      return;
    }

    // ---- 段落（unstyled / 未知ブロック） ----
    const textRoot =
      child.querySelector('.public-DraftStyleDefault-block') || child;
    const text = inlineText(textRoot).replace(/ /g, ' ').trim();
    if (text) blocks.push({ type: 'p', text });
  }

  /**
   * 本文コンテナを走査して、順序を保ったブロック配列を返す。
   * @param {Element} bodyEl
   * @param {Array} images 抽出した画像をここに push する
   * @returns {Array<{type:string, text?:string, imageIndex?:number}>}
   */
  function extractBlocks(bodyEl, images) {
    const blocks = [];
    const seenPhotos = new WeakSet();

    // data-contents 配下の直接の子（各ブロック div / section / ol / ul）を順に処理
    const container = bodyEl.querySelector('[data-contents="true"]') || bodyEl;
    const children = Array.from(container.children);

    for (const child of children) {
      processBlock(child, blocks, images, seenPhotos);
    }

    return blocks;
  }

  /**
   * 著者名・ハンドル・日付などのメタ情報を取得する。
   * @returns {{author:string, handle:string, date:string}}
   */
  function extractMeta() {
    let author = '';
    let handle = '';

    const nameEl = document.querySelector(SEL.userName);
    if (nameEl) {
      // 表示名: 最初のテキスト塊、ハンドル: @から始まるspan
      const spans = Array.from(nameEl.querySelectorAll('span'))
        .map((s) => (s.textContent || '').trim())
        .filter(Boolean);
      author = spans.find((t) => t && !t.startsWith('@')) || '';
      handle = spans.find((t) => t.startsWith('@')) || '';
    }

    // URLからハンドルを補完
    if (!handle) {
      const m = location.pathname.match(/^\/([A-Za-z0-9_]+)\//);
      if (m) handle = '@' + m[1];
    }

    // 公開日: time[datetime] があれば使う
    let date = '';
    const timeEl = document.querySelector('article time[datetime], time[datetime]');
    if (timeEl) date = timeEl.getAttribute('datetime') || '';

    return { author, handle, date };
  }

  /**
   * ページ全体から記事データを抽出するエントリポイント。
   * @returns {null | {title, author, handle, url, date, blocks, images}}
   */
  function extractArticle() {
    if (!isArticlePage()) return null;

    const titleEl = document.querySelector(SEL.title);
    const bodyEl = document.querySelector(SEL.body);
    if (!bodyEl) return null;

    const title = titleEl
      ? (titleEl.textContent || '').replace(/ /g, ' ').trim()
      : '無題の記事';

    const images = [];
    const blocks = extractBlocks(bodyEl, images);
    const meta = extractMeta();

    return {
      title,
      author: meta.author,
      handle: meta.handle,
      url: location.href.split('?')[0],
      date: meta.date,
      blocks,
      images,
    };
  }

  (typeof window!=="undefined"?window:globalThis).ArticleSaverExtractorX = {
    isArticlePage,
    extractArticle,
    normalizeImageUrl,
  };
})();
