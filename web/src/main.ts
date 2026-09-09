import './style.css';
import { Experience } from './engine';

const canvas = document.getElementById('scene') as HTMLCanvasElement;

// Let the renderer check WebGL2 without allocating a second probe context.
try {
  const experience = new Experience(canvas);
  const pageEvents = new AbortController();
  void experience.start();
  if (import.meta.env.DEV) {
    (globalThis as unknown as { atelier: Experience }).atelier = experience;
    import.meta.hot?.dispose(() => { pageEvents.abort(); experience.dispose(); });
  }
  addEventListener('pagehide', (event) => {
    if (!event.persisted) experience.dispose();
  }, { signal: pageEvents.signal });
} catch (error) {
  console.error(error);
  document.getElementById('veil')?.classList.add('lift');
  const box = document.getElementById('fallback')!;
  box.hidden = false;
  document.getElementById('fallbackText')!.textContent =
    'Ta prezentacja potrzebuje WebGL 2. Włącz akcelerację sprzętową lub otwórz stronę w innej przeglądarce.';
}
