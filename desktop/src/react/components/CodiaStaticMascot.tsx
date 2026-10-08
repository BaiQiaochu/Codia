import gazeStrip from '../../assets/codia/codia-mascot-gaze-strip.png';
import styles from './CodiaStaticMascot.module.css';

/** The first, neutral pose of the existing bundled artwork. No animation,
 * WebGL, SDK, service, provider configuration, or network is required. */
export function CodiaStaticMascot() {
  return (
    <div className={styles.mascot} role="img" aria-label="Codia 吉祥物（静态）" data-codia-static-mascot>
      <span className={styles.halo} aria-hidden="true" />
      <div className={styles.frame} aria-hidden="true">
        <img className={styles.sprite} src={gazeStrip} alt="" draggable={false} />
      </div>
    </div>
  );
}
