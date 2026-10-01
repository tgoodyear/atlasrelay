import { useEffect, type RefObject } from 'react';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Keyboard focus for a modal dialog: moves focus into it when it opens, keeps Tab and Shift+Tab
 * inside it while it is open, and hands focus back to whatever had it (the button that opened it)
 * when it closes. aria-modal tells assistive technology the rest of the page is inert, but it does
 * not move or hold focus, so without this a keyboard user stays on the page behind the overlay.
 */
export function useDialogFocus(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = ref.current;
    if (!root) return;
    const focusables = () => Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null || el === document.activeElement);
    (focusables()[0] ?? root).focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) {
        e.preventDefault();
        root.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !root.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !root.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (opener && opener.isConnected) opener.focus();
    };
  }, [ref]);
}
