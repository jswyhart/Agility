// Tab strip: renders the tabs main.js reports and forwards clicks back to it.
const strip = document.getElementById('strip');
document.documentElement.className = `platform-${new URLSearchParams(location.search).get('platform')}`;

window.tabsApi.onUpdate((tabs) => {
  strip.replaceChildren(...tabs.map((t) => {
    const el = document.createElement('div');
    el.className = `tab${t.active ? ' active' : ''}`;
    el.title = t.title;
    const title = Object.assign(document.createElement('span'), { className: 'title', textContent: t.title });
    el.append(title);
    if (t.dirty) el.append(Object.assign(document.createElement('span'), { className: 'dot', title: 'Unsaved changes' }));
    const close = Object.assign(document.createElement('button'), { className: 'close', textContent: '×', title: 'Close tab' });
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      window.tabsApi.close(t.id);
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
