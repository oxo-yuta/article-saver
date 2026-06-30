/**
 * extractor.js（ディスパッチャ）
 * 現在のページのホスト名に応じて、サイト別の抽出実装
 * （ArticleSaverExtractorX / ArticleSaverExtractorNote）を選び、
 * 統一インターフェース ArticleSaverExtractor として公開する。
 *
 * 専用サイトにマッチしない場合は、汎用フォールバック
 * （ArticleSaverExtractorGeneric / Readability）が読み込まれていればそれを使う。
 * generic は通常ページに常駐させず、popup から activeTab 権限で動的注入される。
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
   * 現在のホストに対応する専用サイト定義を返す。
   * @returns {object|null}
   */
  function currentSite() {
    const host = location.hostname;
    return SITES.find((s) => s.test(host)) || null;
  }

  /**
   * 汎用フォールバック実装を返す（注入済みのときのみ）。
   * @returns {object|null}
   */
  function genericImpl() {
    return root.ArticleSaverExtractorGeneric || null;
  }

  /**
   * 現在のサイトの抽出実装を返す。
   * 専用サイトを優先し、無ければ汎用フォールバックを返す。
   * @returns {object|null}
   */
  function impl() {
    const site = currentSite();
    if (site) {
      const e = site.impl();
      if (e) return e;
    }
    return genericImpl();
  }

  /**
   * 現在のページのサイト識別子（'x' | 'note' | 'generic' | null）を返す。
   * @returns {string|null}
   */
  function siteKey() {
    const site = currentSite();
    if (site) return site.key;
    return genericImpl() ? 'generic' : null;
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
