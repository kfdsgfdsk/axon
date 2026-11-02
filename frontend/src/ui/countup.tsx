import React from 'react';

/* Animated number that eases toward its target. Tabular numerals, no layout shift. */
export function CountUp({
  value,
  format,
  duration = 700,
}: {
  value: number;
  format: (n: number) => string;
  duration?: number;
}) {
  const [shown, setShown] = React.useState(value);
  const fromRef = React.useRef(value);
  const rafRef = React.useRef<number>(0);

  React.useEffect(() => {
    const from = fromRef.current;
    if (from === value) return;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      fromRef.current = value;
      setShown(value);
      return;
    }
    const t0 = performance.now();
    const step = (t: number) => {
      const p = Math.min(1, (t - t0) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      const cur = from + (value - from) * eased;
      fromRef.current = cur;
      setShown(cur);
      if (p < 1) rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafRef.current);
  }, [value, duration]);

  return <span className="num-tick">{format(shown)}</span>;
}
