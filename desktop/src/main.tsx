import { createRoot } from 'react-dom/client';
import App from './react/App';
import { PwaLoginGate } from './react/components/PwaLoginGate';

const el = document.getElementById('react-root');
if (el) {
  createRoot(el).render(
    <PwaLoginGate>
      <App />
    </PwaLoginGate>,
  );
}
