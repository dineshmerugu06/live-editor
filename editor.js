/* Live Editor — edit-on-page bookmarklet (v2).
 *
 * This is NOT a separate tool page and NOT an iframe. It injects itself
 * into the live page you are already looking at — the way VisBug and
 * Edit Page work — and edits that page in place, full screen.
 *
 * How it works (same main logic as v1):
 *  1. Every edit becomes data: file + selector + property + old -> new.
 *  2. applyToSource() patches the same element in the real source file
 *     text (fetched from GitHub), not just the pixels on screen.
 *  3. Save sends the patched file to GitHub with the Contents API.
 *     Pages rebuilds in ~1 minute and the live site updates.
 *  No reload anywhere: edits apply to the live page in place.
 *
 * Install: drag the "Edit This Site" link from bookmarklet.html into
 * your bookmarks bar. Then open any GitHub Pages site and click it.
 */
(function () {
  'use strict';
  if (window.__liveEditorOn) { window.__liveEditorOff && window.__liveEditorOff(); return; }
  window.__liveEditorOn = true;

  var EDITOR_JS_VERSION = 1;

  /* ---------- figure out which repo + file this page is ---------- */
  function parseLocation() {
    var host = location.hostname, path = location.pathname;
    var parts = path.split('/').filter(Boolean);
    if (!host.endsWith('github.io')) throw new Error('This only works on a GitHub Pages site (OWNER.github.io/REPO/).');
    var owner = host.replace('.github.io', '');
    var repo = parts[0];
    if (!owner || !repo) throw new Error('No repo in this link.');
    var rest = parts.slice(1).join('/');
    var file;
    if (!rest) file = 'index.html';
    else if (rest.endsWith('/')) file = rest + 'index.html';
    else if (rest.endsWith('.html')) file = rest;
    else file = rest + '/index.html';
    return { owner: owner, repo: repo, path: file, pageUrl: location.href };
  }

  var state = {
    owner: '', repo: '', path: '', branch: 'main', sha: '',
    sourceHtml: '', token: '', changes: [], snapshots: [],
    mode: 'select', selected: null, selector: '', saveTimer: null, dragging: null,
  };
  try { state.token = localStorage.getItem('liveEditor_token') || ''; } catch (e) { state.token = ''; }

  function b64encode(str) {
    var bytes = new TextEncoder().encode(str), bin = '';
    bytes.forEach(function (b) { bin += String.fromCharCode(b); });
    return btoa(bin);
  }
  function b64decode(b64) {
    var bin = atob(b64.replace(/\s/g, ''));
    return new TextDecoder().decode(Uint8Array.from(bin, function (c) { return c.charCodeAt(0); }));
  }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  /* ---------- UI: floating toolbar + log panel, on top of the page ---------- */
  var bar = document.createElement('div');
  bar.id = 'liveedit-bar';
  bar.innerHTML =
    '<b>Live Editor</b>' +
    '<span id="le-site" style="opacity:.75"></span>' +
    '<button data-mode="select" class="le-on">Select</button>' +
    '<button data-mode="text">Text</button>' +
    '<button data-mode="move">Move</button>' +
    '<label>Colour <input type="color" id="le-color" value="#000000"></label>' +
    '<label>Background <input type="color" id="le-bg" value="#ffffff"></label>' +
    '<label>Size <input type="number" id="le-size" value="16" min="8" max="200" style="width:56px">px</label>' +
    '<button id="le-hide">Hide</button>' +
    '<button id="le-del">Delete</button>' +
    '<button id="le-undo">Undo</button>' +
    '<button id="le-save" style="background:#ea580c">Save to GitHub</button>' +
    '<button id="le-log">Change Log</button>' +
    '<button id="le-exit">Exit</button>' +
    '<span id="le-status">Loading file from GitHub…</span>';
  var css = document.createElement('style');
  css.id = 'liveedit-css';
  css.textContent =
    '#liveedit-bar{position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#18181b;color:#fff;' +
    'font:14px system-ui,sans-serif;padding:8px 10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;' +
    'box-shadow:0 2px 12px rgba(0,0,0,.4)}' +
    '#liveedit-bar button{background:#2a2a2e;color:#fff;border:0;border-radius:7px;padding:7px 10px;cursor:pointer;font:14px system-ui,sans-serif}' +
    '#liveedit-bar button.le-on{background:#ea580c}' +
    '#liveedit-bar input{font:14px system-ui,sans-serif}' +
    '#le-status{font-size:13px;color:#fde68a}' +
    '#liveedit-log{position:fixed;top:52px;right:10px;width:360px;max-width:92vw;max-height:70vh;overflow:auto;' +
    'z-index:2147483647;background:#fff;color:#18181b;border:1px solid #ddd;border-radius:10px;padding:12px;' +
    'font:13px system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.3);display:none}' +
    '#liveedit-log h3{margin:0 0 8px;font-size:15px}' +
    '#liveedit-log li{border-bottom:1px solid #f0f0f0;padding:6px 0;list-style:none}' +
    '#liveedit-log ul{margin:0;padding:0}' +
    '#liveedit-log code{background:#f4f4f5;padding:1px 4px;border-radius:4px}' +
    '[data-le-hover]{outline:2px dashed #2563eb !important}' +
    '[data-le-selected]{outline:3px solid #ea580c !important}';
  var logPanel = document.createElement('div');
  logPanel.id = 'liveedit-log';
  logPanel.innerHTML = '<h3>Change Log <span id="le-count" style="font-weight:400;color:#71717a"></span></h3>' +
    '<div style="margin-bottom:8px"><button id="le-copy" style="padding:7px 10px;border:0;border-radius:7px;background:#18181b;color:#fff;cursor:pointer">Copy log</button> ' +
    '<span style="color:#71717a;font-size:12px">No token? Copy the log and send it to Muse — he saves it from the backend.</span></div>' +
    '<ul id="le-list"><li style="color:#71717a">No changes yet.</li></ul>';
  document.head.appendChild(css);
  document.body.appendChild(bar);
  document.body.appendChild(logPanel);

  var $ = function (id) { return document.getElementById(id); };
  function status(msg) { var el = $('le-status'); if (el) el.textContent = msg; }

  /* ---------- fetch the real source file from GitHub ---------- */
  function fetchFile(owner, repo, path, branch, token) {
    var url = 'https://api.github.com/repos/' + owner + '/' + repo + '/contents/' +
      path.split('/').map(encodeURIComponent).join('/') + '?ref=' + branch;
    var headers = { 'Accept': 'application/vnd.github+json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    return fetch(url, { headers: headers }).then(function (res) {
      if (!res.ok) return res.text().then(function (t) { throw new Error('GitHub ' + res.status + ': ' + t.slice(0, 120)); });
      return res.json();
    }).then(function (data) {
      if (!data.content) throw new Error('GitHub returned no file content.');
      return { html: b64decode(data.content), sha: data.sha };
    });
  }

  var parsed;
  try {
    parsed = parseLocation();
    Object.assign(state, parsed);
    $('le-site').textContent = parsed.owner + '/' + parsed.repo + ' — ' + parsed.path;
    fetchFile(parsed.owner, parsed.repo, parsed.path, 'main', state.token)
      .catch(function () { state.branch = 'master'; return fetchFile(parsed.owner, parsed.repo, parsed.path, 'master', state.token); })
      .then(function (file) {
        state.sourceHtml = file.html; state.sha = file.sha;
        status('Loaded. Click an element to edit it.');
      })
      .catch(function (e) { status('Load failed: ' + e.message + ' — you can still edit, but Save needs the file.'); });
  } catch (e) {
    status(e.message);
  }

  /* ---------- selection ---------- */
  function inEditorUI(el) { return el && el.closest && el.closest('#liveedit-bar,#liveedit-log'); }
  function buildSelector(el) {
    if (el.id) return '#' + el.id;
    var parts = [], cur = el;
    while (cur && cur.nodeType === 1 && cur.tagName !== 'BODY' && cur.tagName !== 'HTML') {
      var part = cur.tagName.toLowerCase();
      var cls = Array.prototype.filter.call(cur.classList, function (c) { return c.indexOf('liveedit') !== 0 && c.indexOf('le-') !== 0; }).join('.');
      if (cls) part += '.' + cls;
      var idx = 1, sib = cur.previousElementSibling;
      while (sib) { if (sib.tagName === cur.tagName) idx++; sib = sib.previousElementSibling; }
      part += ':nth-of-type(' + idx + ')';
      parts.unshift(part);
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  }
  function rgbToHex(rgb) {
    var m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(rgb || '');
    if (!m) return '#000000';
    return '#' + [1, 2, 3].map(function (i) { return (+m[i]).toString(16).padStart(2, '0'); }).join('');
  }
  function selectElement(el) {
    document.querySelectorAll('[data-le-selected]').forEach(function (n) { n.removeAttribute('data-le-selected'); });
    el.setAttribute('data-le-selected', '');
    state.selected = el;
    state.selector = buildSelector(el);
    var cs = getComputedStyle(el);
    $('le-color').value = rgbToHex(cs.color);
    $('le-bg').value = rgbToHex(cs.backgroundColor);
    $('le-size').value = Math.round(parseFloat(cs.fontSize)) || 16;
    status('Selected: ' + el.tagName.toLowerCase() + ' — ' + state.selector);
  }

  /* ---------- the core: patch the SOURCE file from a Change ---------- */
  function applyToSource(change) {
    var doc = new DOMParser().parseFromString(state.sourceHtml, 'text/html');
    var el = doc.querySelector(change.selector);
    if (!el) throw new Error('Could not find this element in the code: ' + change.selector);
    if (change.type === 'text') el.textContent = change.newValue;
    else if (change.type === 'delete') el.remove();
    else if (change.type === 'hide') el.style.display = 'none';
    else if (change.type === 'style' || change.type === 'move') {
      el.style.setProperty(change.property, change.newValue);
      if (change.type === 'move') el.style.position = el.style.position || 'relative';
    }
    state.sourceHtml = '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
  }

  function renderLog() {
    var ul = $('le-list');
    $('le-count').textContent = state.changes.length + (state.changes.length === 1 ? ' change' : ' changes');
    if (!state.changes.length) { ul.innerHTML = '<li style="color:#71717a">No changes yet.</li>'; return; }
    ul.innerHTML = state.changes.map(function (c) {
      if (c.type === 'commit') return '<li><b>Committed to GitHub</b> — ' + esc(c.newValue) + '</li>';
      return '<li>[' + esc(c.time) + '] <b>' + esc(c.type) + '</b> <code>' + esc(c.selector) + '</code> — ' +
        esc(c.property) + ': <code>' + esc(String(c.oldValue).slice(0, 60)) + '</code> → <code>' +
        esc(String(c.newValue).slice(0, 60)) + '</code></li>';
    }).join('');
  }
  function logText() {
    return state.changes.map(function (c) {
      return '[' + c.time + '] ' + c.type + ' ' + c.selector + ' — ' + c.property + ': ' + c.oldValue + ' → ' + c.newValue + ' (' + (c.file || state.path) + ')';
    }).join('\n');
  }

  function recordChange(partial) {
    if (!state.selector && partial.type !== 'undo') { status('Select an element on the page first.'); return; }
    state.snapshots.push(state.sourceHtml);
    if (state.snapshots.length > 50) state.snapshots.shift();
    var change = { time: new Date().toLocaleTimeString(), file: state.path || 'index.html', selector: state.selector };
    Object.assign(change, partial);
    try {
      applyToSource(change);
    } catch (e) {
      state.snapshots.pop();
      status('Change NOT saved to code: ' + e.message);
      return;
    }
    state.changes.push(change);
    renderLog();
    // No page reload: the change is already visible on the live element.
    if (change.type === 'hide' && state.selected) state.selected.style.display = 'none';
    if (change.type === 'delete' && state.selected) { state.selected.remove(); state.selected = null; state.selector = ''; }
    status('Changed ' + change.selector + ' — ' + change.property + ': ' + String(change.oldValue).slice(0, 40) + ' → ' + String(change.newValue).slice(0, 40) + '. Auto-saving…');
    scheduleSave();
  }

  function scheduleSave() {
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(saveNow, 2000);
  }

  function saveNow() {
    if (!state.sourceHtml) { status('File not loaded yet — wait a second and press Save again.'); return; }
    if (!state.sha) { status('Log-only: no GitHub file loaded. Copy the log and send it to Muse.'); return; }
    if (!state.token) {
      var t = window.prompt('GitHub token needed to save (fine-grained, Contents Read and write, for this repo only). It stays in this browser only — never in chat. Leave empty for log-only mode:');
      if (t) { state.token = t.trim(); try { localStorage.setItem('liveEditor_token', state.token); } catch (e) {} }
      else { status('No token — change is logged, NOT saved. Copy the log and send it to Muse.'); return; }
    }
    var last = state.changes[state.changes.length - 1];
    var summary = last ? last.type + ' ' + last.selector + ' ' + last.property : 'live edit';
    status('Saving to GitHub…');
    var url = 'https://api.github.com/repos/' + state.owner + '/' + state.repo + '/contents/' +
      state.path.split('/').map(encodeURIComponent).join('/');
    fetch(url, {
      method: 'PUT',
      headers: { 'Accept': 'application/vnd.github+json', 'Authorization': 'Bearer ' + state.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Live edit: ' + summary, content: b64encode(state.sourceHtml), sha: state.sha, branch: state.branch })
    }).then(function (res) {
      if (!res.ok) return res.text().then(function (t) { throw new Error('GitHub ' + res.status + ': ' + t.slice(0, 200)); });
      return res.json();
    }).then(function (data) {
      state.sha = data.content.sha;
      state.changes.push({ time: new Date().toLocaleTimeString(), file: state.path, selector: '', type: 'commit', property: 'github', oldValue: '', newValue: 'commit ' + state.sha.slice(0, 7) });
      renderLog();
      status('Saved ✓ ' + new Date().toLocaleTimeString() + ' — commit ' + state.sha.slice(0, 7) + '. Live site updates in about 1 minute — hard refresh to see it.');
    }).catch(function (e) {
      status('Save failed: ' + e.message + ' — change is still in the log. Press Save to retry.');
    });
  }

  function undo() {
    if (!state.snapshots.length) { status('Nothing to undo.'); return; }
    state.sourceHtml = state.snapshots.pop();
    state.changes.push({ time: new Date().toLocaleTimeString(), file: state.path, selector: state.selector, type: 'undo', property: 'revert', oldValue: '', newValue: 'restored previous file version' });
    renderLog();
    status('Undone in the code — the page itself needs a refresh to show the undo. Auto-saving…');
    scheduleSave();
  }

  /* ---------- text edit ---------- */
  function startTextEdit(el) {
    selectElement(el);
    var oldText = el.textContent;
    el.contentEditable = 'true';
    el.focus();
    var done = function () {
      el.contentEditable = 'false';
      el.removeEventListener('blur', done);
      var newText = el.textContent;
      if (newText !== oldText) recordChange({ type: 'text', property: 'text', oldValue: oldText, newValue: newText });
    };
    el.addEventListener('blur', done);
  }

  /* ---------- page event handlers (capture, so the page does not eat them) ---------- */
  function onClick(e) {
    if (inEditorUI(e.target)) return;
    var el = e.target;
    if (!el || el === document.documentElement || el === document.body) return;
    if (el.closest && el.closest('a')) e.preventDefault();
    if (state.mode === 'text') { startTextEdit(el); e.preventDefault(); e.stopPropagation(); return; }
    selectElement(el);
    e.preventDefault(); e.stopPropagation();
  }
  function onDblClick(e) {
    if (inEditorUI(e.target)) return;
    var el = e.target;
    if (el && el !== document.documentElement && el !== document.body) { startTextEdit(el); e.preventDefault(); }
  }
  function onOver(e) {
    if (inEditorUI(e.target)) return;
    var el = e.target;
    if (el && el !== document.documentElement && el !== document.body) el.setAttribute('data-le-hover', '');
  }
  function onOut(e) { if (e.target) e.target.removeAttribute('data-le-hover'); }
  function onPointerDown(e) {
    if (state.mode !== 'move' || inEditorUI(e.target)) return;
    var el = e.target;
    if (!el || el === document.documentElement || el === document.body) return;
    selectElement(el);
    var m = /translate\(\s*(-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(el.style.transform || '');
    state.dragging = { el: el, startX: e.clientX, startY: e.clientY, baseX: m ? +m[1] : 0, baseY: m ? +m[2] : 0, oldTransform: el.style.transform || '' };
    e.preventDefault(); e.stopPropagation();
  }
  function onPointerMove(e) {
    if (!state.dragging) return;
    var d = state.dragging;
    d.el.style.transform = 'translate(' + Math.round(d.baseX + (e.clientX - d.startX)) + 'px, ' + Math.round(d.baseY + (e.clientY - d.startY)) + 'px)';
    d.el.style.position = d.el.style.position || 'relative';
  }
  function onPointerUp() {
    if (!state.dragging) return;
    var d = state.dragging; state.dragging = null;
    var t = d.el.style.transform || '';
    if (t !== d.oldTransform) recordChange({ type: 'move', property: 'transform', oldValue: d.oldTransform, newValue: t });
  }
  function onKey(e) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !(document.activeElement && document.activeElement.isContentEditable)) {
      e.preventDefault(); undo();
    }
  }
  document.addEventListener('click', onClick, true);
  document.addEventListener('dblclick', onDblClick, true);
  document.addEventListener('mouseover', onOver, true);
  document.addEventListener('mouseout', onOut, true);
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('pointermove', onPointerMove, true);
  document.addEventListener('pointerup', onPointerUp, true);
  document.addEventListener('keydown', onKey);

  /* ---------- toolbar wiring ---------- */
  bar.querySelectorAll('[data-mode]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      state.mode = btn.dataset.mode;
      bar.querySelectorAll('[data-mode]').forEach(function (b) { b.classList.toggle('le-on', b === btn); });
      status('Mode: ' + state.mode + '. ' + (state.mode === 'text' ? 'Click text to edit it.' : state.mode === 'move' ? 'Drag an element to move it.' : 'Click an element to select it.'));
    });
  });
  function applyStyle(property, value) {
    if (!state.selected) { status('Select an element on the page first.'); return; }
    var oldValue = state.selected.style.getPropertyValue(property) || '';
    if (oldValue === value) return;
    state.selected.style.setProperty(property, value);
    recordChange({ type: 'style', property: property, oldValue: oldValue, newValue: value });
  }
  $('le-color').addEventListener('change', function (e) { applyStyle('color', e.target.value); });
  $('le-bg').addEventListener('change', function (e) { applyStyle('background-color', e.target.value); });
  $('le-size').addEventListener('change', function (e) { applyStyle('font-size', e.target.value + 'px'); });
  $('le-hide').addEventListener('click', function () {
    if (!state.selected) { status('Select an element on the page first.'); return; }
    recordChange({ type: 'hide', property: 'display', oldValue: '', newValue: 'none' });
  });
  $('le-del').addEventListener('click', function () {
    if (!state.selected) { status('Select an element on the page first.'); return; }
    recordChange({ type: 'delete', property: 'removed', oldValue: state.selected.outerHTML.slice(0, 60), newValue: '' });
  });
  $('le-undo').addEventListener('click', undo);
  $('le-save').addEventListener('click', saveNow);
  $('le-log').addEventListener('click', function () {
    logPanel.style.display = logPanel.style.display === 'none' ? 'block' : 'none';
  });
  $('le-exit').addEventListener('click', exitEditor);
  $('le-copy').addEventListener('click', function () {
    var txt = logText() || 'No changes yet.';
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(function () { status('Change log copied.'); }, function () { status('Copy failed — select the log text manually.'); });
    } else { status('Copy not supported here — select the log text manually.'); }
  });

  function exitEditor() {
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('dblclick', onDblClick, true);
    document.removeEventListener('mouseover', onOver, true);
    document.removeEventListener('mouseout', onOut, true);
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('pointermove', onPointerMove, true);
    document.removeEventListener('pointerup', onPointerUp, true);
    document.removeEventListener('keydown', onKey);
    document.querySelectorAll('[data-le-selected]').forEach(function (n) { n.removeAttribute('data-le-selected'); });
    if (bar.parentNode) bar.parentNode.removeChild(bar);
    if (logPanel.parentNode) logPanel.parentNode.removeChild(logPanel);
    if (css.parentNode) css.parentNode.removeChild(css);
    window.__liveEditorOn = false;
  }
  window.__liveEditorOff = exitEditor;
  status('Live Editor on. Click an element on this page to edit it.');
})();
