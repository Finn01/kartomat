import { useEffect } from 'react';

// Tracks how many callers currently want the body locked, so nested/overlapping
// callers (e.g. a modal opened while the study session overlay is active) don't
// have one's cleanup re-enable scrolling while the other is still open.
let lockCount = 0;
let savedScrollY = 0;

function lockBody() {
  if (lockCount === 0) {
    savedScrollY = window.scrollY;
    document.body.style.position = 'fixed';
    document.body.style.top = `-${savedScrollY}px`;
    document.body.style.left = '0';
    document.body.style.right = '0';
  }
  lockCount++;
}

function unlockBody() {
  lockCount--;
  if (lockCount === 0) {
    document.body.style.position = '';
    document.body.style.top = '';
    document.body.style.left = '';
    document.body.style.right = '';
    window.scrollTo(0, savedScrollY);
  }
}

// Prevents the page behind a modal or the study session overlay from
// scrolling (touch or mouse/wheel) while `active` is true.
export function useBodyScrollLock(active: boolean) {
  useEffect(() => {
    if (!active) return;
    lockBody();
    return unlockBody;
  }, [active]);
}
