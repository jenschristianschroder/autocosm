import { useEffect, useRef, type ReactNode } from 'react';
import type { JSX } from 'react';

/**
 * Modal shell.
 *
 * Focus is trapped, Escape closes, and focus returns to whatever opened the dialog. This is the
 * only modal pattern in the app so keyboard behaviour is consistent everywhere.
 */

export interface DialogProps {
  readonly title: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}

export function Dialog(props: DialogProps): JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<Element | null>(null);

  useEffect(() => {
    returnFocusRef.current = document.activeElement;
    const first = panelRef.current?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.stopPropagation();
        props.onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = [...(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
      const firstEl = focusable.at(0);
      const lastEl = focusable.at(-1);
      if (!firstEl || !lastEl) return;
      if (event.shiftKey && document.activeElement === firstEl) {
        event.preventDefault();
        lastEl.focus();
      } else if (!event.shiftKey && document.activeElement === lastEl) {
        event.preventDefault();
        firstEl.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      if (returnFocusRef.current instanceof HTMLElement) returnFocusRef.current.focus();
    };
  }, [props]);

  return (
    <div className="dialog__scrim" onMouseDown={props.onClose}>
      <div
        ref={panelRef}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="dialog__header">
          <h2>{props.title}</h2>
          <button
            type="button"
            className="button button--ghost"
            aria-label="Close dialog"
            onClick={props.onClose}
          >
            ✕
          </button>
        </header>
        <div className="dialog__body">{props.children}</div>
      </div>
    </div>
  );
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
