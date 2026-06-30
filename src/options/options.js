/**
 * options.js
 * 設定の読み込み・保存。chrome.storage.sync を使用。
 */
(function () {
  'use strict';

  const DEFAULTS = {
    vaultDir: 'ObsidianVault',
    noteSubDir: 'Clippings',
    attachmentSubDir: 'Clippings/attachments',
    filenamePattern: '{date}-{slug}',
    tags: ['x-article'],
  };

  const els = {
    vaultDir: document.getElementById('vaultDir'),
    noteSubDir: document.getElementById('noteSubDir'),
    attachmentSubDir: document.getElementById('attachmentSubDir'),
    filenamePattern: document.getElementById('filenamePattern'),
    tags: document.getElementById('tags'),
    preview: document.getElementById('preview'),
    saveBtn: document.getElementById('saveBtn'),
    saved: document.getElementById('saved'),
  };

  function updatePreview() {
    const vault = els.vaultDir.value.trim() || DEFAULTS.vaultDir;
    const note = els.noteSubDir.value.trim() || DEFAULTS.noteSubDir;
    const att = els.attachmentSubDir.value.trim() || DEFAULTS.attachmentSubDir;
    const pattern = els.filenamePattern.value.trim() || DEFAULTS.filenamePattern;
    const sampleName = pattern
      .replace('{date}', '2026-06-30')
      .replace('{slug}', '記事のタイトル')
      .replace('{handle}', 'author_handle');
    els.preview.textContent =
      `ノート: ~/Downloads/${vault}/${note}/${sampleName}.md\n` +
      `画像  : ~/Downloads/${vault}/${att}/${sampleName}-1.jpg`;
  }

  async function load() {
    const stored = await chrome.storage.sync.get(DEFAULTS);
    const s = { ...DEFAULTS, ...stored };
    els.vaultDir.value = s.vaultDir;
    els.noteSubDir.value = s.noteSubDir;
    els.attachmentSubDir.value = s.attachmentSubDir;
    els.filenamePattern.value = s.filenamePattern;
    els.tags.value = (s.tags || []).join(', ');
    updatePreview();
  }

  async function save() {
    const tags = els.tags.value
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);

    const settings = {
      vaultDir: els.vaultDir.value.trim() || DEFAULTS.vaultDir,
      noteSubDir: els.noteSubDir.value.trim() || DEFAULTS.noteSubDir,
      attachmentSubDir:
        els.attachmentSubDir.value.trim() || DEFAULTS.attachmentSubDir,
      filenamePattern:
        els.filenamePattern.value.trim() || DEFAULTS.filenamePattern,
      tags,
    };

    await chrome.storage.sync.set(settings);
    els.saved.classList.add('show');
    setTimeout(() => els.saved.classList.remove('show'), 1800);
  }

  // 入力のたびにプレビュー更新
  for (const key of ['vaultDir', 'noteSubDir', 'attachmentSubDir', 'filenamePattern']) {
    els[key].addEventListener('input', updatePreview);
  }
  els.saveBtn.addEventListener('click', save);

  load();
})();
