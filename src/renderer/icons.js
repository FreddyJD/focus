'use strict';

/**
 * Icon set.
 *
 * One consistent 24x24 stroked grid so every glyph shares the same optical
 * weight. Built as SVG strings rather than a font: no extra network request,
 * no FOUT, and `currentColor` means icons inherit state colour for free.
 *
 * Wrapped in an IIFE so nothing leaks into the global scope. Classic <script>
 * tags share one global scope, so a top-level `function icon` here would
 * collide with `const icon` in any page script that consumes it.
 */
(function () {
  const PATHS = {
    plus: '<path d="M12 5v14M5 12h14"/>',
    close: '<path d="M18 6 6 18M6 6l12 12"/>',
    minimize: '<path d="M5 12h14"/>',
    back: '<path d="M15 18l-6-6 6-6"/>',
    forward: '<path d="M9 18l6-6-6-6"/>',
    reload: '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>',
    pause: '<path d="M9.5 5v14M14.5 5v14"/>',
    play: '<path d="M7 4.5v15l12-7.5z" fill="currentColor" stroke-linejoin="round"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    settings:
      '<circle cx="12" cy="12" r="3"/>' +
      '<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    shieldCheck:
      '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/>',
    lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
    globe:
      '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/>' +
      '<path d="M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18z"/>',
    slash: '<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    app:
      '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/>' +
      '<rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    alert:
      '<path d="M12 9v4"/><path d="M12 17h.01"/>' +
      '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
    arrowRight: '<path d="M5 12h14"/><path d="M13 6l6 6-6 6"/>',
    sparkle:
      '<path d="M12 3l1.6 5.2a2 2 0 0 0 1.3 1.3L20 11l-5.1 1.5a2 2 0 0 0-1.3 1.3L12 19l-1.6-5.2a2 2 0 0 0-1.3-1.3L4 11l5.1-1.5a2 2 0 0 0 1.3-1.3z"/>',
    chat:
      '<path d="M21 12a8 8 0 0 1-8 8H7l-4 3v-5.5A8 8 0 0 1 11 4h2a8 8 0 0 1 8 8z"/>',
  };

  /**
   * @param {string} name key of PATHS
   * @param {string} size '' | 'xs' | 'sm' | 'lg'
   */
  function icon(name, size = '') {
    const body = PATHS[name];
    if (!body) return '';
    const cls = size ? `icon icon-${size}` : 'icon';
    return `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${body}</svg>`;
  }

  window.Icons = { icon, PATHS };
})();
