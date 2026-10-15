import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useBodyScrollLock } from '../hooks/useBodyScrollLock';

interface ModalProps {
  onClose: () => void;
  children: React.ReactNode;
  contentStyle?: React.CSSProperties;
}

// The part of the screen actually visible: on phones the on-screen keyboard shrinks the *visual*
// viewport but not the layout viewport that `position: fixed` is measured against, so an overlay
// that just fills `inset: 0` keeps centring its content behind the keyboard. Tracking the visual
// viewport lets the overlay shrink to the space above the keyboard instead. `offsetTop` is
// non-zero when iOS pans the visual viewport to reveal the focused input.
function useVisualViewportBox() {
  const [box, setBox] = useState<{ top: number; height: number } | null>(null);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => setBox({ top: vv.offsetTop, height: vv.height });
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);

  return box;
}

// Rendered via a portal straight to document.body so `position: fixed`
// resolves against the real viewport. Without this, a modal opened while
// nested inside a `transform`-ed ancestor (e.g. the tab swipe track) would
// center itself relative to that ancestor instead of the screen.
export const Modal: React.FC<ModalProps> = ({ onClose, children, contentStyle }) => {
  useBodyScrollLock(true);
  const viewportBox = useVisualViewportBox();

  return createPortal(
    <div
      className="modal-overlay"
      onClick={onClose}
      style={viewportBox ? { top: viewportBox.top, bottom: 'auto', height: viewportBox.height } : undefined}
    >
      <div className="modal-content" onClick={(e) => e.stopPropagation()} style={contentStyle}>
        {children}
      </div>
    </div>,
    document.body
  );
};
