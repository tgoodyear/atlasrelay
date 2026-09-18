// Applies the web-font stylesheet once it has downloaded.
//
// The stylesheet ships as media="print" so it does not block first paint, and this flips it to
// media="all". That switch used to be an inline onload attribute, which is inline script: the
// deployed CSP is script-src 'self', so browsers enforcing it never ran it and the fonts silently
// never applied to anyone. Same-origin files are allowed by that policy, so the logic lives here.
//
// Without JavaScript the <noscript> block in index.html loads the stylesheet the ordinary way.
(function () {
  var link = document.getElementById('webfonts');
  if (link) link.media = 'all';
})();
