import React from 'react';
import { createPortal } from 'react-dom';

interface ModalProps {
  onClose: () => void;
  children: React.ReactNode;
  contentStyle?: React.CSSProperties;
}

// Rendered via a portal straight to document.body so `position: fixed`
// resolves against the real viewport. Without this, a modal opened while
// nested inside a `transform`-ed ancestor (e.g. the tab swipe track) would
// center itself relative to that ancestor instead of the screen.
export const Modal: React.FC<ModalProps> = ({ onClose, children, contentStyle }) => {
  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()} style={contentStyle}>
        {children}
      </div>
    </div>,
    document.body
  );
};
