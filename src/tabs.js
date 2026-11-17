// Tab strip: renders the tabs main.js reports and forwards clicks, drags and keys back to it.
const tabsEl = document.getElementById('tabs');
const listBtn = document.getElementById('list');
document.documentElement.className = `platform-${new URLSearchParams(location.search).get('platform')}`;

let tabs = [];
const tabEl = (id) => tabsEl.querySelector(`.tab[data-id="${id}"]`);

// The × closes its tab on release, as in browsers. It's matched by tab id, not by
// element, because an update can rebuild the strip between press and release.
let pressedClose = null;
// A tab being dragged: { id, x, y, moved, waiting }. Dragging sideways reorders;
// letting go well above or below the strip moves the tab to a window of its own.
let drag = null;
const DRAG_START = 6;
const DETACH_DISTANCE = 40;
const outsideStrip = (e) => e.clientY < -DETACH_DISTANCE || e.clientY > window.innerHeight + DETACH_DISTANCE;

window.addEventListener('mousemove', (e) => {
  if (!drag) return;
  if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < DRAG_START) return;
  drag.moved = true;
  const el = tabEl(drag.id);
  if (!el) return;
  el.classList.add('dragging');
  el.classList.toggle('detaching', outsideStrip(e) && tabs.length > 1);
  if (drag.waiting || outsideStrip(e)) return;
  // The tab's place is the number of other tabs whose middle is left of the pointer.
  const others = [...tabsEl.querySelectorAll('.tab')].filter((t) => t !== el);
  const index = others.filter((t) => {
    const r = t.getBoundingClientRect();
    return r.left + r.width / 2 < e.clientX;
  }).length;
  if (index !== tabs.findIndex((t) => t.id === drag.id)) {
    drag.waiting = true; // until the strip is redrawn in the new order
    window.tabsApi.move(drag.id, index);
  }
});

window.addEventListener('mouseup', (e) => {
  const id = pressedClose;
  pressedClose = null;
  if (e.button === 0 && id != null && e.target.closest?.('.close')?.dataset.id === String(id)) window.tabsApi.close(id);
  if (drag && e.button === 0) {
    const { id: dragged, moved } = drag;
    drag = null;
    tabEl(dragged)?.classList.remove('dragging', 'detaching');
    if (moved && outsideStrip(e) && tabs.length > 1) window.tabsApi.detach(dragged);
  }
});

function render() {
  const hadFocus = tabsEl.contains(document.activeElement);
  tabsEl.replaceChildren(...tabs.map((t) => {
    const el = document.createElement('div');
    el.className = `tab${t.active ? ' active' : ''}${drag?.moved && drag.id === t.id ? ' dragging' : ''}`;
    el.dataset.id = t.id;
    el.title = t.title;
    el.setAttribute('role', 'tab');
    el.setAttribute('aria-selected', String(t.active));
    el.setAttribute('aria-label', `${t.title}${t.dirty ? ', unsaved changes' : ''}`);
    el.tabIndex = t.active ? 0 : -1;
    const title = Object.assign(document.createElement('span'), { className: 'title', textContent: t.title });
    el.append(title);
    if (t.dirty) el.append(Object.assign(document.createElement('span'), { className: 'dot', title: 'Unsaved changes' }));
    const close = Object.assign(document.createElement('button'), { className: 'close', textContent: '×', title: 'Close tab', tabIndex: -1 });
    close.setAttribute('aria-label', `Close ${t.title}`);
    close.dataset.id = t.id;
    // Pressing × mustn't activate the tab: activating rebuilds this strip and moves
    // focus to the document, so the release would never reach this button.
    close.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      if (e.button === 0) pressedClose = t.id;
    });
    el.append(close);
    el.addEventListener('mousedown', (e) => {
      if (e.button === 1) {
        e.preventDefault(); // no autoscroll cursor
        window.tabsApi.close(t.id); // middle-click closes
      } else if (e.button === 0) {
        drag = { id: t.id, x: e.clientX, y: e.clientY, moved: false, waiting: false };
        window.tabsApi.activate(t.id);
      }
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      window.tabsApi.contextMenu(t.id);
    });
    return el;
  }));
  if (drag) drag.waiting = false;
  const active = tabsEl.querySelector('.tab.active');
  if (!drag?.moved) active?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  if (hadFocus) active?.focus();
  updateOverflow();
}

// The ▾ button lists every tab; it's only needed when some are scrolled out of view.
function updateOverflow() {
  listBtn.hidden = tabsEl.scrollWidth <= tabsEl.clientWidth + 1;
}
window.addEventListener('resize', updateOverflow);
tabsEl.addEventListener('wheel', (e) => {
  tabsEl.scrollLeft += Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
}, { passive: true });

// Keyboard: F6 puts focus on the active tab. Arrows, Home and End switch tabs,
// Enter or Escape goes back to the document, Delete closes, and the menu key
// (or Shift+F10) opens the tab's menu.
tabsEl.addEventListener('keydown', (e) => {
  const i = tabs.findIndex((t) => t.active);
  if (i < 0) return;
  const go = (n) => {
    e.preventDefault();
    window.tabsApi.activate(tabs[(n + tabs.length) % tabs.length].id, { focus: false });
  };
  if (e.key === 'ArrowRight') go(i + 1);
  else if (e.key === 'ArrowLeft') go(i - 1);
  else if (e.key === 'Home') go(0);
  else if (e.key === 'End') go(tabs.length - 1);
  else if (e.key === 'Enter' || e.key === ' ' || e.key === 'Escape') {
    e.preventDefault();
    window.tabsApi.activate(tabs[i].id);
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    window.tabsApi.close(tabs[i].id);
  } else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
    e.preventDefault();
    window.tabsApi.contextMenu(tabs[i].id);
  }
});

document.getElementById('new').addEventListener('click', () => window.tabsApi.newTab());
listBtn.addEventListener('click', () => window.tabsApi.listTabs());

window.tabsApi.onFocus(() => tabsEl.querySelector('.tab.active')?.focus());
window.tabsApi.onUpdate((next) => {
  tabs = next;
  render();
});
