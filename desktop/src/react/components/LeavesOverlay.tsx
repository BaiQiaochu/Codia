/**
  *
 *
  * */

import { memo, useRef, useEffect, useState } from 'react';

//
import leavesSrc from '../../assets/textures/leaves-overlay.mp4';

export const LeavesOverlay = memo(function LeavesOverlay() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [enabled, setEnabled] = useState(
    () => localStorage.getItem('codia-leaves-overlay') === '1',
  );

  // Listen for cross-window settings updates.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.type === 'leaves-overlay-changed') {
        setEnabled(detail.enabled);
      }
    };
    window.addEventListener('codia-settings', handler);
    return () => window.removeEventListener('codia-settings', handler);
  }, []);

 // 确保视频播放
  useEffect(() => {
    if (enabled && videoRef.current) {
      videoRef.current.play().catch(() => {});
    }
  }, [enabled]);

  if (!enabled) return null;

  return (
    <>
      {/* 亮度补偿，避免 multiply 视频变暗 */}
      <div
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 139,
          pointerEvents: 'none',
          background: 'color-mix(in srgb, var(--bg) 12%, transparent)',
        }}
      />
      <video
        ref={videoRef}
        autoPlay
        loop
        muted
        playsInline
        style={{
          position: 'fixed',
          inset: 0,
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          mixBlendMode: 'multiply',
          opacity: 0.28,
          pointerEvents: 'none',
          zIndex: 140,
        }}
      >
        <source src={leavesSrc} type="video/mp4" />
      </video>
    </>
  );
});
