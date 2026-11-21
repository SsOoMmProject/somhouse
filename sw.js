/* App shell for when the network is gone. Always asks the network first, so a deployment shows up right away;
   a saved copy is used only when the network fails or takes too long. Family records and API calls never pass
   through here. */
'use strict';
const CACHE = 'somhouse-shell-v1';
const SHELL = ['./', 'index.html', 'style.css', 'config.js', 'service.js', 'shared.js', 'ai-direct.js', 'ai-help.js',
  'insights.js', 'features.js', 'app.js', 'features/offline.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];
const WAIT_MS = 4000;

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE)
    .then(cache => Promise.all(SHELL.map(path => cache.add(new Request(path, {cache: 'reload'})).catch(() => {}))))
    .then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys()
    .then(names => Promise.all(names.filter(name => name.startsWith('somhouse-shell-') && name !== CACHE).map(name => caches.delete(name))))
    .then(() => self.clients.claim()));
});

// Only the app's own static files of this folder.
function isShell(request) {
  if (request.method !== 'GET') return false;
  const url = new URL(request.url), home = new URL('./', self.location.href);
  if (url.origin !== home.origin || !url.pathname.startsWith(home.pathname)) return false;
  const name = url.pathname.slice(home.pathname.length);
  if (name.startsWith('api/') || name.startsWith('auth/')) return false;
  return name === '' || /^(?:features\/)?[a-z0-9-]+\.(?:html|js|css|png|webmanifest)$/.test(name);
}
async function saved(request) {
  return await caches.match(request, {ignoreSearch: true})
    || (request.mode === 'navigate' ? await caches.match('index.html', {ignoreSearch: true}) : undefined);
}
async function answer(event) {
  const request = event.request;
  const network = fetch(request).then(response => {
    if (response.ok && response.type === 'basic') {
      const copy = response.clone();
      event.waitUntil(caches.open(CACHE).then(cache => cache.put(request, copy)).catch(() => {}));
    }
    return response;
  });
  let timer;
  const slow = new Promise(resolve => { timer = setTimeout(resolve, WAIT_MS, 'slow'); });
  try {
    const first = await Promise.race([network, slow]);
    if (first !== 'slow') return first;
    return await saved(request) || await network;
  } catch {
    return await saved(request) || Response.error();
  } finally { clearTimeout(timer); }
}
self.addEventListener('fetch', event => {
  if (isShell(event.request)) event.respondWith(answer(event));
});
