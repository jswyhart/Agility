// Tab strip: renders the tabs main.js reports and forwards clicks back to it.
const strip = document.getElementById('strip');
document.documentElement.className = `platform-${new URLSearchParams(location.search).get('platform')}`;

// The × closes its tab on release, as in browsers. It's matched by tab id, not by
// element, because an update can rebuild the strip between press and release.
let pressedClose = null;
window.addEventListener('mouseup', (e) => {
  const id = pressedClose;
  pressedClose = null;
  if (e.button === 0 && id != null && e.target.closest?.('.close')?.dataset.id === String(id)) window.tabsApi.close(id);
});

window.tabsApi.onUpdate((tabs) => {
  strip.replaceChildren(...tabs.map((t) => {
    const el = document.createElement('div');
    el.className = `tab${t.active ? ' active' : ''}`;
    el.title = t.title;
    const title = Object.assign(document.createElement('span'), { className: 'title', textContent: t.title });
    el.append(title);
    if (t.dirty) el.append(Object.assign(document.createElement('span'), { className: 'dot', title: 'Unsaved changes' }));
    const close = Object.assign(document.createElement('button'), { className: 'close', textContent: '×', title: 'Close tab' });
    close.dataset.id = t.id;
    // Pressing × mustn't activate the tab: activating rebuilds this strip and moves
    // focus to the document, so the release would never reach this button.
    close.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      if (e.button === 0) pressedClose = t.id;
    });
    el.append(close);
    el.addEventListener('mousedown', (e) => {
      if (e.button === 1) window.tabsApi.close(t.id); // middle-click closes
      else if (e.button === 0) window.tabsApi.activate(t.id);
    });
    return el;
  }));
  const plus = Object.assign(document.createElement('button'), { className: 'new', textContent: '+', title: 'New tab' });
  plus.addEventListener('click', () => window.tabsApi.newTab());
  strip.append(plus);
});
