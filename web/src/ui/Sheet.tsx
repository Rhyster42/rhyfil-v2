import { useEffect, useRef, type ReactNode } from 'react';

interface SheetProps {
  title?: string;
  onClose?: () => void;
  wide?: boolean;
  children: ReactNode;
}

/** A modal panel over the current screen. */
export function Sheet({ title, onClose, wide, children }: SheetProps) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close.current?.();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="sheet-backdrop" onClick={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className={`sheet${wide ? ' sheet-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        {title && (
          <header className="sheet-header">
            <h2>{title}</h2>
            {onClose && (
              <button type="button" className="btn btn-ghost" onClick={onClose} aria-label="Close">
                ✕
              </button>
            )}
          </header>
        )}
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  );
}
