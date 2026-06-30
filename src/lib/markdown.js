/**
 * markdown.js
 * extractor が生成した構造化データ + 画像ファイル名割り当てから
 * Obsidian向けMarkdown文字列を生成する。
 * (typeof window!=="undefined"?window:globalThis).ArticleSaverMarkdown に公開。
 */
(function () {
  'use strict';

  /**
   * YAMLフロントマターの文字列値を安全にクォートする。
   * @param {string} v
   * @returns {string}
   */
  function yamlString(v) {
    const s = (v || '').replace(/"/g, '\\"');
    return `"${s}"`;
  }

  /**
   * 段落テキスト内のMarkdown特殊文字のうち、意図せず装飾化する恐れがある
   * 行頭記号のみ最小限エスケープする（本文の読みやすさ優先で過剰には行わない）。
   *
   * 注意: 行頭が太字/斜体マーカー（**bold** や *italic*）の場合はエスケープしない。
   *       エスケープ対象は「リスト/見出し/引用に誤認される記号」だけに限定する。
   *       - `#` `>` は行頭なら常に対象
   *       - `-` `+` は「記号 + 空白」のときだけリストマーカーとして対象
   *       - `*` は「* + 空白」のときだけ（箇条書き記号）。`**` や `*語` は装飾なので除外
   * @param {string} text
   * @returns {string}
   */
  function escapeBlockText(text) {
    return text
      .replace(/^(\s*)([#>])/gm, '$1\\$2')
      .replace(/^(\s*)([-+*])(\s)/gm, '$1\\$2$3');
  }

  /**
   * 構造化記事データと画像ファイル名マップからMarkdownを生成する。
   *
   * @param {object} article extractArticle() の戻り値
   * @param {object} opts
   * @param {string[]} opts.imageWikilinks images[] と同じ並びの Wikilink本体
   *        (例 "Clippings/attachments/foo-1.jpg")。失敗した画像は null。
   * @param {string[]} [opts.tags] フロントマターに付与するタグ
   * @param {string} opts.savedAt YYYY-MM-DD
   * @returns {string}
   */
  function buildMarkdown(article, opts) {
    const { imageWikilinks = [], tags = [], savedAt = '' } = opts || {};
    const lines = [];

    // ---- フロントマター ----
    lines.push('---');
    lines.push(`title: ${yamlString(article.title)}`);
    if (article.author) lines.push(`author: ${yamlString(article.author)}`);
    if (article.handle) lines.push(`author_handle: ${yamlString(article.handle)}`);
    lines.push(`source: ${yamlString(article.url)}`);
    if (article.date) lines.push(`published_at: ${yamlString(article.date)}`);
    if (savedAt) lines.push(`saved_at: ${savedAt}`);
    if (tags.length) {
      lines.push('tags:');
      for (const t of tags) lines.push(`  - ${t}`);
    }
    lines.push('---');
    lines.push('');

    // ---- 見出し(記事タイトル) ----
    lines.push(`# ${article.title}`);
    lines.push('');

    // ---- 本文ブロック ----
    let listMode = null; // 連続リストの区切り管理
    for (const block of article.blocks) {
      const flushListGap = () => {
        if (listMode) {
          lines.push('');
          listMode = null;
        }
      };

      switch (block.type) {
        case 'h2':
          flushListGap();
          lines.push(`## ${block.text}`);
          lines.push('');
          break;
        case 'h3':
          flushListGap();
          lines.push(`### ${block.text}`);
          lines.push('');
          break;
        case 'quote':
          flushListGap();
          lines.push(
            block.text
              .split('\n')
              .map((l) => `> ${l}`)
              .join('\n')
          );
          lines.push('');
          break;
        case 'ul':
          if (listMode !== 'ul' && lines[lines.length - 1] !== '') {
            // 直前が空行でなければ詰める必要はないが見やすさのため何もしない
          }
          lines.push(`- ${block.text}`);
          listMode = 'ul';
          break;
        case 'ol':
          lines.push(`1. ${block.text}`);
          listMode = 'ol';
          break;
        case 'image': {
          flushListGap();
          const link = imageWikilinks[block.imageIndex];
          if (link) {
            // Obsidian Wikilink埋め込み
            lines.push(`![[${link}]]`);
          } else {
            // ダウンロード失敗時はオリジナルURLにフォールバック
            const img = article.images[block.imageIndex];
            if (img && img.url) lines.push(`![](${img.url})`);
          }
          lines.push('');
          break;
        }
        case 'caption':
          flushListGap();
          // 画像キャプションは引用ではなく控えめな強調(イタリック)で表現
          lines.push(`*${block.text}*`);
          lines.push('');
          break;
        case 'code': {
          flushListGap();
          const lang = block.lang || '';
          lines.push('```' + lang);
          lines.push(block.text);
          lines.push('```');
          lines.push('');
          break;
        }
        case 'table': {
          flushListGap();
          const rows = Array.isArray(block.rows) ? block.rows : [];
          if (rows.length) {
            const cols = Math.max(...rows.map((r) => r.length));
            // セル内の | と改行はGFMテーブルを壊すのでエスケープ/置換する
            const cell = (v) =>
              String(v == null ? '' : v)
                .replace(/\|/g, '\\|')
                .replace(/\r?\n/g, '<br>')
                .trim();
            const pad = (r) => {
              const c = r.slice(0, cols);
              while (c.length < cols) c.push('');
              return c.map(cell);
            };
            const header = pad(rows[0]);
            lines.push(`| ${header.join(' | ')} |`);
            lines.push(`| ${header.map(() => '---').join(' | ')} |`);
            for (const r of rows.slice(1)) {
              lines.push(`| ${pad(r).join(' | ')} |`);
            }
            lines.push('');
          }
          break;
        }
        case 'embed':
          flushListGap();
          // 埋め込み（note記事カード・外部ページ）はURLリンクとして残す
          if (block.url) lines.push(`<${block.url}>`);
          lines.push('');
          break;
        case 'hr':
          flushListGap();
          lines.push('---');
          lines.push('');
          break;
        case 'p':
        default:
          flushListGap();
          lines.push(escapeBlockText(block.text));
          lines.push('');
          break;
      }
    }

    // 末尾の空行を1つに整える
    let md = lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
    return md + '\n';
  }

  (typeof window!=="undefined"?window:globalThis).ArticleSaverMarkdown = { buildMarkdown };
})();
