export function SplashApp() {
  return (
    <div className="splash-container">
      <img
        className="splash-avatar"
        // Keep the splash entry independent from the main renderer graph. The
        // file is copied verbatim into dist-renderer by the renderer build.
        src="./assets/codia/codia-brand-emblem.png"
        alt="Codia"
        draggable={false}
      />
      <strong className="splash-brand">Codia</strong>
      <div className="splash-text-row">
        <p className="splash-text" aria-live="polite">正在初始化…</p>
      </div>
    </div>
  );
}
