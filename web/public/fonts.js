// Applies the web-font stylesheet once it has actually downloaded.
//
// The stylesheet ships as media="print" so it does not block first paint, and this flips it to
// media="all". That switch used to be an inline onload attribute, which is inline script: the
// deployed CSP is script-src 'self', so browsers enforcing it never ran it and the fonts silently
// never applied to anyone. Same-origin files are allowed by that policy, so the logic lives here.
//
// It has to wait for the stylesheet's own load event rather than run on sight. This script is
// deferred, so it executes when the document has been parsed, which says nothing about whether a
// cross-origin request to fonts.googleapis.com has come back. Promoting a still-pending sheet to
// media="all" makes it render-blocking from that moment, which is the first-paint dependency the
// media="print" trick exists to avoid.
//
// If the request fails the media stays "print" and the fallback stack in the CSS is used. Without
// JavaScript the <noscript> block in index.html loads the stylesheet the ordinary way.
(function () {
  var link = document.getElementById('webfonts');
  if (!link) return;
  var apply = function () { link.media = 'all'; };
  // `sheet` is populated once the stylesheet has been fetched and parsed, which covers the case
  // where it arrived (or was served from cache) before this script ran and its load event is gone.
  if (link.sheet) apply();
  else link.addEventListener('load', apply, { once: true });
})();
