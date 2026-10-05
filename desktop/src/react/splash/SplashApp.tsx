import { useEffect, useState } from 'react';
import { getDesktopApi } from '../utils/desktop-api';
import { localFilePathToUrl } from '../utils/local-file-url';
import { yuanFallbackAvatar } from '../utils/yuan-avatar';

export function SplashApp() {
  const [avatarSrc, setAvatarSrc] = useState(yuanFallbackAvatar('gsap'));
  const [text] = useState('正在初始化…');

  useEffect(() => {
    (async () => {
      let yuan = 'gsap';

      try {
        const gsapApi = getDesktopApi();
        const [avatarPath, splashInfo] = await Promise.all([
          gsapApi?.getAvatarPath?.('agent'),
          gsapApi?.getSplashInfo?.(),
        ]);

        if (splashInfo?.yuan) yuan = splashInfo.yuan;

        if (avatarPath) {
          setAvatarSrc(`${localFilePathToUrl(avatarPath)}?t=${Date.now()}`);
        } else {
          setAvatarSrc(yuanFallbackAvatar(yuan));
        }
      } catch {
        setAvatarSrc(yuanFallbackAvatar('gsap'));
      }
    })();
  }, []);

  return (
    <div className="splash-container">
      <img
        className="splash-avatar"
        src={avatarSrc}
        alt=""
        draggable={false}
      />
      <strong className="splash-brand">Codia</strong>
      <div className="splash-text-row">
        <p className="splash-text" aria-live="polite">{text}</p>
      </div>
    </div>
  );
}
