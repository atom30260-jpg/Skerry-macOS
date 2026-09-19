let hideTimer = 0;

export function inferToastKind(text, kind) {
  if (kind) return kind;
  const t = String(text || '');
  if (/失败|未通过|无效|错误|✕|未完成/.test(t)) return 'error';
  if (/成功|已发送|已保存|已登录|已启用|已删除|已退出|已设为|已创建|✓/.test(t)) return 'success';
  if (/请/.test(t)) return 'warning';
  return 'info';
}

function host() {
  if (typeof document === 'undefined') return null;
  let el = document.getElementById('notice');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'notice';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.setAttribute('popover', 'manual');
  document.body.appendChild(el);
  return el;
}

function isPopoverOpen(el) {
  try { return el.matches(':popover-open'); } catch { return false; }
}

function showHost(el) {
  el.classList.add('cc-toast-open');
  if (typeof el.showPopover !== 'function') return;
  if (isPopoverOpen(el)) return;
  try { el.showPopover(); } catch { /* already open */ }
}

export function hideNotice() {
  clearTimeout(hideTimer);
  hideTimer = 0;
  const el = typeof document === 'undefined' ? null : document.getElementById('notice');
  if (!el) return;
  el.classList.remove('cc-toast-open');
  if (typeof el.hidePopover === 'function' && isPopoverOpen(el)) {
    try { el.hidePopover(); } catch { /* ignore */ }
  }
}

export function notice(text, kind) {
  const el = host();
  if (!el) return;
  const type = inferToastKind(text, kind);
  el.className = `cc-toast ${type} cc-toast-open`;
  el.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite');
  el.replaceChildren();
  const msg = document.createElement('p');
  msg.className = 'cc-toast-msg';
  msg.textContent = String(text ?? '');
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'cc-toast-close';
  close.setAttribute('aria-label', '关闭提示');
  close.textContent = '×';
  close.addEventListener('click', hideNotice);
  el.append(msg, close);
  showHost(el);
  clearTimeout(hideTimer);
  const sticky = type === 'info' && /正在|准备/.test(String(text || ''));
  if (sticky) return;
  const ms = type === 'error' ? 8000 : type === 'warning' ? 7000 : 5000;
  hideTimer = setTimeout(hideNotice, ms);
}
