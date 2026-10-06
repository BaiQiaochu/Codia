import codiaBrandEmblem from '../../assets/codia/codia-brand-emblem.png';

export function SplashApp() {
  return (
    <div className="splash-container">
      <img
        className="splash-avatar"
        src={codiaBrandEmblem}
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
