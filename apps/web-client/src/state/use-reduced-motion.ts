import { useEffect, useState } from 'react';

/**
 * Reduced-motion preference.
 *
 * When set, the scene stops decorative animation and snaps to the newest snapshot instead of
 * easing toward it. The world is still fully legible; it just does not move on its own.
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => query()?.matches ?? false);

  useEffect(() => {
    const media = query();
    if (!media) return;
    const onChange = (event: MediaQueryListEvent): void => setReduced(event.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  return reduced;
}

function query(): MediaQueryList | undefined {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
  return window.matchMedia('(prefers-reduced-motion: reduce)');
}
