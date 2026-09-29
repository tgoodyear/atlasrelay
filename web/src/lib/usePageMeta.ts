import { useEffect } from 'react';
import { canonicalUrl, DEFAULT_DESCRIPTION, documentTitle, type PageMeta } from './pages';

function setMeta(attr: 'name' | 'property', key: string, content: string | null): void {
  let el = document.head.querySelector<HTMLMetaElement>(`meta[${attr}="${key}"]`);
  if (content === null) {
    el?.remove();
    return;
  }
  if (!el) {
    el = document.createElement('meta');
    el.setAttribute(attr, key);
    document.head.appendChild(el);
  }
  el.content = content;
}

function setCanonical(href: string | null): void {
  let el = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (href === null) {
    el?.remove();
    return;
  }
  if (!el) {
    el = document.createElement('link');
    el.rel = 'canonical';
    document.head.appendChild(el);
  }
  el.href = href;
}

/**
 * Keep the head in step with the page on screen. The server sends each kind of page with its own
 * head (see pages.ts), but moving around inside the app never reloads the document, so without
 * this the tab kept the first page's title and a crawler that runs scripts kept its canonical URL.
 */
export function usePageMeta({ title, description, path, noindex }: PageMeta): void {
  useEffect(() => {
    const fullTitle = documentTitle(title);
    const desc = description || DEFAULT_DESCRIPTION;
    const url = path && !noindex ? canonicalUrl(path) : null;
    document.title = fullTitle;
    setMeta('name', 'description', desc);
    setMeta('property', 'og:title', fullTitle);
    setMeta('property', 'og:description', desc);
    setMeta('name', 'twitter:title', fullTitle);
    setMeta('name', 'twitter:description', desc);
    setMeta('property', 'og:url', url);
    setCanonical(url);
    setMeta('name', 'robots', noindex ? 'noindex' : null);
  }, [title, description, path, noindex]);
}
