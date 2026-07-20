import React, { useRef, useState, useEffect } from 'react';

interface RubberBandContentProps {
  children: React.ReactNode;
  disabled?: boolean;
}

export const RubberBandContent: React.FC<RubberBandContentProps> = ({ children, disabled = false }) => {
  const contentRef = useRef<HTMLDivElement>(null);
  const [translateY, setTranslateY] = useState(0);
  const [isTransitioning, setIsTransitioning] = useState(false);

  const startYRef = useRef(0);
  const touchStateRef = useRef<'idle' | 'pulling-down' | 'pulling-up'>('idle');
  const lastYRef = useRef(0);
  const isTouchActiveRef = useRef(false);

  useEffect(() => {
    const el = contentRef.current;
    if (!el || disabled) return;

    // Native momentum scrolling can carry scrollTop to a boundary *after* the
    // last touchmove has already fired (finger lifted, inertia still running).
    // Since the idle->pulling transition below only ever runs inside a
    // touchmove handler, that case would otherwise be missed until a brand
    // new gesture starts. Tracking the boundary via `scroll` (which keeps
    // firing during momentum) lets us arm the pulling state the instant the
    // boundary is crossed, so if the finger is still down we catch it on the
    // very next touchmove instead of requiring a fresh gesture.
    const handleScroll = () => {
      if (!isTouchActiveRef.current || touchStateRef.current !== 'idle') return;

      const scrollTop = window.scrollY || document.documentElement.scrollTop;
      const scrollHeight = document.documentElement.scrollHeight;
      const clientHeight = document.documentElement.clientHeight;

      if (scrollTop <= 0) {
        touchStateRef.current = 'pulling-down';
        startYRef.current = lastYRef.current;
      } else if (scrollTop + clientHeight >= scrollHeight - 1) {
        touchStateRef.current = 'pulling-up';
        startYRef.current = lastYRef.current;
      }
    };

    const handleTouchStart = (e: TouchEvent) => {
      startYRef.current = e.touches[0].clientY;
      lastYRef.current = e.touches[0].clientY;
      isTouchActiveRef.current = true;
      setIsTransitioning(false);

      const scrollTop = window.scrollY || document.documentElement.scrollTop;
      const scrollHeight = document.documentElement.scrollHeight;
      const clientHeight = document.documentElement.clientHeight;

      if (scrollTop <= 0) {
        touchStateRef.current = 'pulling-down';
      } else if (scrollTop + clientHeight >= scrollHeight - 1) {
        touchStateRef.current = 'pulling-up';
      } else {
        touchStateRef.current = 'idle';
      }
    };

    const handleTouchMove = (e: TouchEvent) => {
      const currentY = e.touches[0].clientY;
      const diffY = currentY - startYRef.current;
      lastYRef.current = currentY;

      const scrollTop = window.scrollY || document.documentElement.scrollTop;
      const scrollHeight = document.documentElement.scrollHeight;
      const clientHeight = document.documentElement.clientHeight;

      // Dynamically lock to pulling-down/up if they reach bounds during touch
      if (touchStateRef.current === 'idle') {
        if (scrollTop <= 0 && diffY > 0) {
          touchStateRef.current = 'pulling-down';
          startYRef.current = currentY; // reset start point to avoid jumps
          return;
        } else if (scrollTop + clientHeight >= scrollHeight - 1 && diffY < 0) {
          touchStateRef.current = 'pulling-up';
          startYRef.current = currentY; // reset start point to avoid jumps
          return;
        }
      }

      if (touchStateRef.current === 'pulling-down') {
        if (diffY > 0) {
          if (e.cancelable) e.preventDefault();
          // Logarithmic/Power resistance formula:
          const resistance = Math.pow(diffY, 0.68) * 1.6;
          setTranslateY(resistance);
        } else {
          setTranslateY(0);
          touchStateRef.current = 'idle';
        }
      } else if (touchStateRef.current === 'pulling-up') {
        if (diffY < 0) {
          if (e.cancelable) e.preventDefault();
          const resistance = -Math.pow(Math.abs(diffY), 0.68) * 1.6;
          setTranslateY(resistance);
        } else {
          setTranslateY(0);
          touchStateRef.current = 'idle';
        }
      }
    };

    const handleTouchEnd = () => {
      isTouchActiveRef.current = false;
      setIsTransitioning(true);
      setTranslateY(0);
      touchStateRef.current = 'idle';
    };

    window.addEventListener('touchstart', handleTouchStart, { passive: true });
    window.addEventListener('touchmove', handleTouchMove, { passive: false });
    window.addEventListener('touchend', handleTouchEnd, { passive: true });
    window.addEventListener('scroll', handleScroll, { passive: true });

    return () => {
      window.removeEventListener('touchstart', handleTouchStart);
      window.removeEventListener('touchmove', handleTouchMove);
      window.removeEventListener('touchend', handleTouchEnd);
      window.removeEventListener('scroll', handleScroll);
    };
  }, [disabled]);

  // Snap back immediately if disabled mid-gesture (e.g. a study session opens while pulling).
  useEffect(() => {
    if (disabled) {
      touchStateRef.current = 'idle';
      isTouchActiveRef.current = false;
      setIsTransitioning(false);
      setTranslateY(0);
    }
  }, [disabled]);

  return (
    <div 
      ref={contentRef}
      style={{
        transform: `translate3d(0, ${translateY}px, 0)`,
        transition: isTransitioning ? 'transform 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)' : 'none',
        width: '100%',
        willChange: 'transform',
      }}
    >
      {children}
    </div>
  );
};
