/**
 * filename.js
 * ファイル名・スラッグ・日付整形などの純粋ユーティリティ。
 * content / background 双方から使うため (typeof window!=="undefined"?window:globalThis).ArticleSaverFilename に公開する。
 */
(function () {
  'use strict';

  /**
   * ファイル名に使えない文字を除去/置換する（Win/Mac両対応）。
   * @param {string} name
   * @returns {string}
   */
  function sanitize(name) {
    return (name || '')
      .replace(/[\/\\:*?"<>|]/g, '') // OS禁止文字
      .replace(/[\x00-\x1f\x7f]/g, '') // 制御文字
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * タイトルからURL/ファイル名向けのスラッグを作る。
   * 日本語はそのまま残しつつ、記号類だけ落として読めるファイル名にする。
   * @param {string} title
   * @returns {string}
   */
  function slugify(title) {
    let s = sanitize(title);
    s = s
      .replace(/[\s　]+/g, '-') // 全角/半角空白をハイフンに
      .replace(/[、。「」『』（）()\[\]【】！!？?…‥・:：;；,，.。]/g, '')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    // 長すぎる場合は切り詰め
    if (s.length > 80) s = s.slice(0, 80).replace(/-$/, '');
    return s || 'x-article';
  }

  /**
   * Date を YYYY-MM-DD 形式に整形する。
   * @param {Date} d
   * @returns {string}
   */
  function formatDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  /**
   * パスのセグメントを結合する（重複スラッシュを排除）。
   * @param {...string} parts
   * @returns {string}
   */
  function joinPath(...parts) {
    return parts
      .filter((p) => p != null && p !== '')
      .map((p) => String(p).replace(/^\/+|\/+$/g, ''))
      .filter(Boolean)
      .join('/');
  }

  /**
   * パターン文字列を値で埋める。利用可能: {date} {slug} {handle}
   * @param {string} pattern
   * @param {{date:string, slug:string, handle:string}} vals
   * @returns {string}
   */
  function applyPattern(pattern, vals) {
    const p = pattern && pattern.trim() ? pattern : '{date}-{slug}';
    return sanitize(
      p
        .replace(/\{date\}/g, vals.date || '')
        .replace(/\{slug\}/g, vals.slug || '')
        .replace(/\{handle\}/g, (vals.handle || '').replace(/^@/, ''))
    ).replace(/^-+|-+$/g, '');
  }

  /**
   * 画像の拡張子をURLから推定する（既定 jpg）。
   * @param {string} url
   * @returns {string}
   */
  function imageExt(url) {
    try {
      const u = new URL(url, 'https://pbs.twimg.com');
      const fmt = u.searchParams.get('format');
      if (fmt) return fmt.toLowerCase() === 'jpeg' ? 'jpg' : fmt.toLowerCase();
      const m = u.pathname.match(/\.([a-zA-Z0-9]+)$/);
      if (m) return m[1].toLowerCase();
    } catch (e) {
      /* noop */
    }
    return 'jpg';
  }

  (typeof window!=="undefined"?window:globalThis).ArticleSaverFilename = {
    sanitize,
    slugify,
    formatDate,
    joinPath,
    applyPattern,
    imageExt,
  };
})();
