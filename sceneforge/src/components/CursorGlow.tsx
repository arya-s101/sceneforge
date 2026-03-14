import React, { useEffect, useRef } from 'react';

/**
 * CursorGlow — zero re-render implementation.
 * Uses refs + direct style.transform mutation on mousemove so React is never
 * involved in the hot path. This eliminates dozens of re-renders per second
 * that the previous useState version caused, which was a major scroll/perf hit.
 */
const CursorGlow: React.FC = () => {
  const glowRef = useRef<HTMLDivElement>(null);
  const dotRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const glow = glowRef.current;
    const dot = dotRef.current;
    if (!glow || !dot) return;

    const onMove = (e: MouseEvent) => {
      // GPU-accelerated positioning — no layout reads, no React re-renders
      const tx = `translate(${e.clientX - 120}px, ${e.clientY - 120}px)`;
      glow.style.transform = tx;
      dot.style.transform = `translate(${e.clientX - 2}px, ${e.clientY - 2}px)`;
    };

    window.addEventListener('mousemove', onMove, { passive: true });
    return () => window.removeEventListener('mousemove', onMove);
  }, []);

  return (
    <>
      {/* Soft Glow — positioned via transform, not top/left, for GPU compositing */}
      <div
        ref={glowRef}
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          width: '240px',
          height: '240px',
          background: 'radial-gradient(circle, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0) 70%)',
          borderRadius: '50%',
          pointerEvents: 'none',
          zIndex: 9998,
          willChange: 'transform',
        }}
      />
      {/* Sharp Dot */}
      <div
        ref={dotRef}
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          width: '4px',
          height: '4px',
          backgroundColor: 'rgba(255, 255, 255, 0.9)',
          borderRadius: '50%',
          pointerEvents: 'none',
          zIndex: 9999,
          boxShadow: '0 0 8px 2px rgba(255, 255, 255, 0.4)',
          willChange: 'transform',
        }}
      />
    </>
  );
};

export default CursorGlow;
