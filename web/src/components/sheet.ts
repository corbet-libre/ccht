/** Small DOM helpers shared by the assistant and accounts components:
 * the mobile-sheet media query, visible-focusable lookup, a Tab trap and a
 * dialog action (initial focus, Escape, optional trap, focus return).
 * They never fetch or store anything.
 */

/** Widths up to this render as a full-screen sheet. */
export const sheetQuery = '(max-width: 640px)';

const focusableSelector =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], summary, [tabindex]:not([tabindex="-1"])';

/** Report whether `query` matches now and whenever it changes. Returns the cleanup. */
export function watchMedia(query: string, on: (matches: boolean) => void): () => void {
  if (typeof matchMedia !== 'function') {
    on(false);
    return () => {};
  }
  const list = matchMedia(query);
  on(list.matches);
  const handler = (event: MediaQueryListEvent): void => on(event.matches);
  list.addEventListener?.('change', handler);
  return () => list.removeEventListener?.('change', handler);
}

function isVisible(node: HTMLElement): boolean {
  if (node.closest('[inert], [hidden]')) return false;
  if (typeof node.checkVisibility === 'function') return node.checkVisibility({ visibilityProperty: true });
  const style = getComputedStyle(node);
  return style.display !== 'none' && style.visibility !== 'hidden';
}

/** Enabled, visible controls inside `root`, in tab order of the document. */
export function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(focusableSelector)].filter(isVisible);
}

/** Keep Tab / Shift+Tab inside `root`. */
export function trapTab(event: KeyboardEvent, root: HTMLElement | null | undefined): void {
  if (event.key !== 'Tab' || !root) return;
  const nodes = focusables(root);
  if (nodes.length === 0) {
    event.preventDefault();
    root.focus();
    return;
  }
  const first = nodes[0]!;
  const last = nodes[nodes.length - 1]!;
  const active = document.activeElement;
  const inside = !!active && root.contains(active);
  if (event.shiftKey && (!inside || active === first)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (!inside || active === last)) {
    event.preventDefault();
    first.focus();
  }
}

export interface DialogParams {
  /** Keep Tab inside the dialog (use for the modal sheet). */
  trap: boolean;
  onEscape: () => void;
}

/** Svelte action for a dialog that mounts when opened: focus the first control,
 * close on Escape, optionally trap Tab, and return focus to the opener on destroy. */
export function dialog(node: HTMLElement, initial: DialogParams): { update(next: DialogParams): void; destroy(): void } {
  let params = initial;
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && !event.defaultPrevented) {
      event.preventDefault();
      params.onEscape();
    } else if (params.trap) {
      trapTab(event, node);
    }
  };
  document.addEventListener('keydown', onKeydown);
  (focusables(node)[0] ?? node).focus();
  return {
    update(next) {
      params = next;
    },
    destroy() {
      document.removeEventListener('keydown', onKeydown);
      if (opener?.isConnected) opener.focus();
    },
  };
}
