/* Only SoundDD launch links; the editor's React/CSS stays scoped to its page. */
(function () {
 'use strict';
 function prepare(link) {
  if (!link || !link.href) return;
  let url; try { url = new URL(link.href, location.href); } catch (_) { return; }
  if (url.origin === location.origin && /\/wp-admin\/admin\.php$/.test(url.pathname) && url.searchParams.get('page') === 'sdd-stock-price') {
   link.target = '_blank'; link.rel = 'noopener noreferrer';
  }
 }
 document.querySelectorAll('a[href]').forEach(prepare);
 document.addEventListener('click', function (event) { prepare(event.target.closest && event.target.closest('a[href]')); }, true);
})();
