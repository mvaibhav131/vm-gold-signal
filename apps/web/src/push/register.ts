/**
 * Registers the service worker of the app (`public/sw.js`): it shows the notifications that the server pushes. Only in a
 * build for production (the development server has no reason to run one) and only where the browser has service workers.
 * A failed registration is not an error of the page: the Web Push section says that the worker is not running when the
 * owner tries to subscribe.
 */
export function registerServiceWorker(
  options: {
    production?: boolean;
    container?: Pick<ServiceWorkerContainer, 'register'> | undefined;
    loaded?: () => boolean;
    onLoad?: (callback: () => void) => void;
  } = {},
): void {
  const production = options.production ?? import.meta.env.PROD;
  const container =
    'container' in options
      ? options.container
      : 'serviceWorker' in navigator
        ? navigator.serviceWorker
        : undefined;
  if (!production || container === undefined) return;
  const register = () => {
    container.register('/sw.js', { scope: '/' }).catch(() => undefined);
  };
  const loaded = options.loaded ?? (() => document.readyState === 'complete');
  const onLoad =
    options.onLoad ??
    ((callback: () => void) => {
      window.addEventListener('load', callback, { once: true });
    });
  // after the page has loaded, so the worker never competes with the first screen for the network
  if (loaded()) register();
  else onLoad(register);
}
