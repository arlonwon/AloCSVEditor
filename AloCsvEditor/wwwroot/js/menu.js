// 自定义右键菜单（DESIGN.md F-18；WebView2 默认菜单已关）。
// items: [{label, hint?, action, disabled?} | {sep:true}]，调用方按右键目标组装。
export function showMenu(x, y, items) {
  hideMenu();
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  for (const it of items) {
    if (it.sep) {
      const s = document.createElement('div');
      s.className = 'ctx-sep';
      menu.append(s);
      continue;
    }
    const d = document.createElement('div');
    d.className = 'ctx-item' + (it.disabled ? ' disabled' : '');
    const lab = document.createElement('span');
    lab.textContent = it.label;
    d.append(lab);
    if (it.hint) {
      const h = document.createElement('span');
      h.className = 'ctx-hint';
      h.textContent = it.hint;
      d.append(h);
    }
    if (!it.disabled) {
      d.addEventListener('click', () => {
        hideMenu();
        it.action();
      });
    }
    menu.append(d);
  }
  document.body.append(menu);
  // 先挂载再量尺寸，钳制到视口内。
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.max(4, Math.min(x, window.innerWidth - r.width - 8)) + 'px';
  menu.style.top = Math.max(4, Math.min(y, window.innerHeight - r.height - 8)) + 'px';
}

export function hideMenu() {
  document.querySelectorAll('.ctx-menu').forEach((m) => m.remove());
}

// 全局收尾：别处按下 / Esc / 滚动 / 失焦即收菜单。scroller 传进来挂滚动收尾。
// #7：用 pointerdown 捕获代替 click——mousedown 上的 preventDefault 可能吞掉 click，
// pointerdown 一定先到；菜单内按下放行（走 item 自己的 click）；blur 覆盖点到窗体外的情况。
export function initMenu(scroller) {
  document.addEventListener('pointerdown', (e) => {
    if (e.target.closest?.('.ctx-menu')) return;
    hideMenu();
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideMenu();
  });
  scroller.addEventListener('scroll', () => hideMenu(), { passive: true });
  window.addEventListener('blur', () => hideMenu());
}
