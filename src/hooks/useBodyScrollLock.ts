import { useEffect, useSyncExternalStore } from 'react';

// Tracks how many callers currently want the body locked, so nested/overlapping
// callers (e.g. a modal opened while the study session overlay is active) don't
// have one's cleanup re-enable scrolling while the other is still open.
let lockCount = 0;
let savedScrollY = 0;

// Subscribers to the locked/unlocked transition. Anything that reacts to page
// scroll globally (see RubberBandContent) has to stand down while the body is
// pinned, since the page is no longer what the user is scrolling.
const listeners = new Set<() => void>();

function setLockCount(next: number) {
  const wasLocked = lockCount > 0;
  lockCount = next;
  if (wasLocked !== lockCount > 0) listeners.forEach(l => l());
}

function lockBody() {
  if (lockCount === 0) {
    savedScrollY = window.scrollY;
    document.body.style.position = 'fixed';
    document.body.style.top = `-${savedScrollY}px`;
    document.body.style.left = '0';
    document.body.style.right = '0';
  }
  setLockCount(lockCount + 1);
}

function unlockBody() {
  setLockCount(lockCount - 1);
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

// True while anything holds the body scroll lock. Lets global scroll/touch
// gesture handlers disable themselves for as long as an overlay owns scrolling.
export function useIsBodyScrollLocked(): boolean {
  return useSyncExternalStore(
    listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => lockCount > 0,
    () => false
  );
}
