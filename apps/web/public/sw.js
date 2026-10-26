// The service worker of the app (04_API_and_Notifications section 5). It does two things: it shows a notification when the
// server pushes one, and it opens the right page when the owner taps it. It has no `fetch` handler and keeps no cache, so
// every request goes to the network and no answer of the API is ever stored on the device.
// A plain file on purpose: it is served as it is from the root (its scope is the whole site), it cannot import anything, and the
// policy of Caddy (script-src 'self') allows it. The tests run this very file (apps/web/src/push/serviceWorker.test.ts).

const ICON = '/icons/icon-192.png';
const BADGE = '/icons/badge-96.png';
const TITLE = 'VM Gold Signal';

self.addEventListener('install', () => {
  // a new version takes over at once: there is nothing in it that an old page depends on
  void self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

/**
 * What the server pushed: `{ title, body, url, tag }` as JSON. A push that cannot be read is still shown, with a plain
 * text: a browser that gets a push and shows nothing puts up a notification of its own, saying the site was updated.
 */
function readMessage(event) {
  let data = null;
  try {
    data = event.data ? event.data.json() : null;
  } catch (error) {
    data = null;
  }
  const text = (value, fallback) =>
    typeof value === 'string' && value.trim() !== '' ? value.slice(0, 300) : fallback;
  if (data === null || typeof data !== 'object') {
    return { title: TITLE, body: 'There is a new alert. Open the app.', url: '/', tag: undefined };
  }
  return {
    title: text(data.title, TITLE),
    body: text(data.body, ''),
    url: typeof data.url === 'string' ? data.url : '/',
    tag: typeof data.tag === 'string' && data.tag !== '' ? data.tag.slice(0, 200) : undefined,
  };
}

/** A page of this site: a path that the server sent, never an address of another site. */
function pageOf(url) {
  try {
    const target = new URL(url, self.location.origin);
    if (target.origin !== self.location.origin) return '/';
    return target.pathname + target.search + target.hash;
  } catch (error) {
    return '/';
  }
}

self.addEventListener('push', (event) => {
  const message = readMessage(event);
  const options = {
    body: message.body,
    icon: ICON,
    badge: BADGE,
    data: { url: pageOf(message.url) },
  };
  if (message.tag !== undefined) {
    // a newer message about the same signal replaces the older one, and tells the owner again
    options.tag = message.tag;
    options.renotify = true;
  }
  event.waitUntil(self.registration.showNotification(message.title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data;
  const path = pageOf(data && typeof data.url === 'string' ? data.url : '/');
  const target = new URL(path, self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      const open = windows.find((each) => new URL(each.url).origin === self.location.origin);
      if (open === undefined) return self.clients.openWindow(target);
      // the page that is open is taken to the signal; when it cannot be navigated, a new one is opened
      return open
        .focus()
        .then((focused) => (focused ?? open).navigate(target))
        .then((navigated) => navigated ?? self.clients.openWindow(target))
        .catch(() => self.clients.openWindow(target));
    }),
  );
});
