/**
 * extractor.js（ディスパッチャ）
 * 現在のページのホスト名に応じて、サイト別の抽出実装
 * （ArticleSaverExtractorX / ArticleSaverExtractorNote）を選び、
 * 統一インターフェース ArticleSaverExtractor として公開する。
 *
 * content script からクラシックスクリプトとして読み込まれるため、
 * このファイルは extractor-x.js / extractor-note.js より後に読み込むこと。
 */
(function () {
  'use strict';

  const root = typeof window !== 'undefined' ? window : globalThis;

  // サイト定義: 判定用ホスト名パターンと、対応する実装・既定タグ
  const SITES = [
    {
      key: 'x',
      test: (host) => /(^|\.)x\.com$/.test(host) || /(^|\.)twitter\.com$/.test(host),
      impl: () => root.ArticleSaverExtractorX,
    },
    {
      key: 'note',
      test: (host) => /(^|\.)note\.com$/.test(host),
      impl: () => root.ArticleSaverExtractorNote,
    },
  ];

  /**
   * 現在のホストに対応するサイト定義を返す。
   * @returns {object|null}
   */
  function currentSite() {
    const host = location.hostname;
    return SITES.find((s) => s.test(host)) || null;
  }

  /**
   * 現在のサイトの抽出実装を返す。
   * @returns {object|null}
   */
  function impl() {
    const site = currentSite();
    return site ? site.impl() || null : null;
  }

  /**
   * 現在のページのサイト識別子（'x' | 'note' | null）を返す。
   * @returns {string|null}
   */
  function siteKey() {
    const site = currentSite();
    return site ? site.key : null;
  }

  /**
   * 記事ページかどうかを判定する。
   * @returns {boolean}
   */
  function isArticlePage() {
    const e = impl();
    return !!(e && e.isArticlePage && e.isArticlePage());
  }

  /**
   * 記事データを抽出する。
   * @returns {object|null}
   */
  function extractArticle() {
    const e = impl();
    return e && e.extractArticle ? e.extractArticle() : null;
  }

  /**
   * 画像URLを最適画質に正規化する（サイト実装に委譲）。
   * @param {string} url
   * @returns {string}
   */
  function normalizeImageUrl(url) {
    const e = impl();
    return e && e.normalizeImageUrl ? e.normalizeImageUrl(url) : url;
  }

  root.ArticleSaverExtractor = {
    isArticlePage,
    extractArticle,
    normalizeImageUrl,
    siteKey,
  };
})();
