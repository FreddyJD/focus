'use strict';

/**
 * Minimal markdown renderer for chat messages.
 *
 * Bundled locally rather than pulled from a CDN: the app runs offline and the
 * CSP forbids remote script. Output is escaped first and only a fixed set of
 * tags is produced, so model output can never inject HTML.
 */
(function () {
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function inline(text) {
    let t = escapeHtml(text);

    // `code`
    t = t.replace(/`([^`\n]+)`/g, (_, c) => `<code>${c}</code>`);
    // **bold**
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    // *italic* / _italic_
    t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    t = t.replace(/(^|\W)_([^_\n]+)_(\W|$)/g, '$1<em>$2</em>$3');
    // [text](url) — http(s) only, so no javascript: links
    t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');

    return t;
  }

  function render(md) {
    const src = String(md || '');
    const out = [];
    const lines = src.split('\n');

    let i = 0;
    while (i < lines.length) {
      const line = lines[i];

      // fenced code block
      const fence = line.match(/^```(\w*)/);
      if (fence) {
        const lang = fence[1] || '';
        const body = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) {
          body.push(lines[i]);
          i++;
        }
        i++; // closing fence
        out.push(
          `<pre data-lang="${escapeHtml(lang)}"><code>${escapeHtml(body.join('\n'))}</code></pre>`
        );
        continue;
      }

      // heading
      const h = line.match(/^(#{1,4})\s+(.*)$/);
      if (h) {
        const level = Math.min(4, h[1].length) + 2; // h3..h6, keeps page hierarchy
        out.push(`<h${level}>${inline(h[2])}</h${level}>`);
        i++;
        continue;
      }

      // list
      if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
        const ordered = /^\s*\d+\./.test(line);
        const items = [];
        while (
          i < lines.length &&
          (/^\s*[-*+]\s+/.test(lines[i]) || /^\s*\d+\.\s+/.test(lines[i]))
        ) {
          items.push(inline(lines[i].replace(/^\s*(?:[-*+]|\d+\.)\s+/, '')));
          i++;
        }
        const tag = ordered ? 'ol' : 'ul';
        out.push(`<${tag}>${items.map((x) => `<li>${x}</li>`).join('')}</${tag}>`);
        continue;
      }

      // blank
      if (!line.trim()) {
        i++;
        continue;
      }

      // paragraph
      const para = [];
      while (i < lines.length && lines[i].trim() && !/^```|^#{1,4}\s|^\s*[-*+]\s|^\s*\d+\.\s/.test(lines[i])) {
        para.push(lines[i]);
        i++;
      }
      out.push(`<p>${inline(para.join(' '))}</p>`);
    }

    return out.join('');
  }

  window.MD = { render, escapeHtml };
})();
