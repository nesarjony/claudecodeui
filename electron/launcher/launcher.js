(function cloudCliChrome() {
  'use strict';

  var mockBridge = {
    getState: function () {
      return Promise.resolve({
        connected: false,
        serverUrl: null,
        recentServers: [],
        defaultServerUrl: 'https://dev.nesar.dev',
        layout: 1,
        panes: [],
        geometry: null,
      });
    },
    connectServer: function () { return Promise.resolve(); },
    connectRecent: function () { return Promise.resolve(); },
    showConnectScreen: function () { return Promise.resolve(); },
    forgetServer: function () { return Promise.resolve(); },
    setLayout: function () { return Promise.resolve(); },
    setPaneUrl: function () { return Promise.resolve(); },
    newSessionInPane: function () { return Promise.resolve(); },
    focusPane: function () { return Promise.resolve(); },
    expandPane: function () { return Promise.resolve(); },
    clearPane: function () { return Promise.resolve(); },
    reloadPane: function () { return Promise.resolve(); },
    listProjects: function () { return Promise.resolve([]); },
    listSessions: function () { return Promise.resolve([]); },
    openSessionInPane: function () { return Promise.resolve(); },
    setOverlay: function () { return Promise.resolve(); },
    openExternal: function () { return Promise.resolve(); },
    onStateUpdated: function () { return function () {}; },
  };

  var bridge = window.cloudcliDesktop || mockBridge;
  var STATE = null;

  var titlebar = document.getElementById('titlebar');
  var tbLeft = document.getElementById('tb-left');
  var tbCenter = document.getElementById('tb-center');
  var tbRight = document.getElementById('tb-right');
  var panesLayer = document.getElementById('panes-layer');
  var connectEl = document.getElementById('connect');

  if (/Mac/i.test(navigator.platform || navigator.userAgent)) {
    document.body.classList.add('is-mac');
  }

  // ---- Layout icons -------------------------------------------------------
  function layoutSvg(n) {
    var r = 'rx="1.4"';
    var rects;
    if (n === 1) rects = '<rect x="2" y="2" width="16" height="16" ' + r + '/>';
    else if (n === 2) rects = '<rect x="2" y="2" width="7" height="16" ' + r + '/><rect x="11" y="2" width="7" height="16" ' + r + '/>';
    else if (n === 3) rects = '<rect x="2" y="2" width="7" height="16" ' + r + '/><rect x="11" y="2" width="7" height="7" ' + r + '/><rect x="11" y="11" width="7" height="7" ' + r + '/>';
    else rects = '<rect x="2" y="2" width="7" height="7" ' + r + '/><rect x="11" y="2" width="7" height="7" ' + r + '/><rect x="2" y="11" width="7" height="7" ' + r + '/><rect x="11" y="11" width="7" height="7" ' + r + '/>';
    return '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6">' + rects + '</svg>';
  }

  function el(tag, cls, html) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (html != null) node.innerHTML = html;
    return node;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function positionRect(node, rect) {
    node.style.left = rect.x + 'px';
    node.style.top = rect.y + 'px';
    node.style.width = rect.width + 'px';
    node.style.height = rect.height + 'px';
  }

  // ---- Render dispatch ----------------------------------------------------
  function render(state) {
    STATE = state;
    if (!state || !state.connected) renderConnect(state || {});
    else renderGrid(state);
  }

  // ---- Connect screen -----------------------------------------------------
  function renderConnect(state) {
    panesLayer.hidden = true;
    clear(panesLayer);
    connectEl.hidden = false;

    // Titlebar: brand only.
    clear(tbLeft); clear(tbCenter); clear(tbRight);
    tbLeft.appendChild(el('span', 'tb-title', 'CloudCLI'));

    var recents = state.recentServers || [];
    var defaultUrl = state.serverUrl || recents[0] || state.defaultServerUrl || 'https://dev.nesar.dev';

    clear(connectEl);
    var card = el('div', 'card');
    card.appendChild(el('div', 'brandmark', '⌁'));
    card.appendChild(el('h1', null, 'Connect to your CloudCLI'));
    card.appendChild(el('p', 'subtitle', 'Point the app at a server you are running.'));

    var row = el('div', 'connect-row');
    var input = el('input');
    input.type = 'text';
    input.value = defaultUrl;
    input.placeholder = 'https://your-server';
    input.spellcheck = false;
    input.autocapitalize = 'off';
    input.setAttribute('autocorrect', 'off');
    var connectBtn = el('button', 'btn-primary', 'Connect');
    row.appendChild(input);
    row.appendChild(connectBtn);
    card.appendChild(row);

    var errorEl = el('div', 'error', '');
    card.appendChild(errorEl);

    function doConnect(layout) {
      var url = input.value.trim();
      if (!url) { errorEl.textContent = 'Enter a server URL.'; return; }
      connectBtn.disabled = true;
      connectBtn.textContent = 'Connecting…';
      errorEl.textContent = '';
      Promise.resolve(bridge.connectServer(url, layout || 1)).then(function (next) {
        if (next) render(next);
      }).catch(function (err) {
        connectBtn.disabled = false;
        connectBtn.textContent = 'Connect';
        errorEl.textContent = (err && err.message) ? err.message : String(err);
      });
    }

    connectBtn.addEventListener('click', function () { doConnect(1); });
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') doConnect(1); });

    var openas = el('div', 'openas');
    openas.appendChild(el('span', null, 'Open as'));
    [[1, '1 pane'], [2, '2 panes'], [4, '4 panes']].forEach(function (pair) {
      var chip = el('button', 'chip', pair[1]);
      chip.addEventListener('click', function () { doConnect(pair[0]); });
      openas.appendChild(chip);
    });
    card.appendChild(openas);

    if (recents.length) {
      var rec = el('div', 'recents');
      rec.appendChild(el('h2', null, 'Recent'));
      recents.forEach(function (url) {
        var item = el('div', 'recent');
        var urlEl = el('span', 'r-url', url);
        urlEl.addEventListener('click', function () {
          input.value = url;
          doConnect(STATE && STATE.layout ? STATE.layout : 1);
        });
        var connect = el('button', 'connect', 'connect ↵');
        connect.addEventListener('click', function () { input.value = url; doConnect(1); });
        var forget = el('button', 'forget', '✕');
        forget.addEventListener('click', function () {
          Promise.resolve(bridge.forgetServer(url)).then(function (next) { if (next) render(next); });
        });
        item.appendChild(urlEl);
        item.appendChild(connect);
        item.appendChild(forget);
        rec.appendChild(item);
      });
      card.appendChild(rec);
    }

    connectEl.appendChild(card);
    setTimeout(function () { input.focus(); input.select(); }, 30);
  }

  // ---- Connected grid chrome ---------------------------------------------
  function renderGrid(state) {
    connectEl.hidden = true;
    clear(connectEl);
    panesLayer.hidden = false;

    // --- Slim titlebar: layout switcher (center) + focused-pane controls (right) ---
    clear(tbLeft); clear(tbCenter); clear(tbRight);

    var seg = el('div', 'seg');
    [1, 2, 3, 4].forEach(function (n) {
      var b = el('button', state.layout === n ? 'active' : null, layoutSvg(n));
      b.title = n + (n === 1 ? ' pane' : ' panes');
      b.addEventListener('click', function () {
        Promise.resolve(bridge.setLayout(n)).then(function (next) { if (next) render(next); });
      });
      seg.appendChild(b);
    });
    tbCenter.appendChild(seg);

    var activeId = state.activePaneId;
    var activePane = (state.panes || []).find(function (p) { return p.id === activeId; });

    var rl = el('button', 'icon-btn', '⟳');
    rl.title = 'Reload focused pane';
    rl.addEventListener('click', function () { bridge.reloadPane(activeId); });
    tbRight.appendChild(rl);

    if (state.layout > 1) {
      var ex = el('button', 'icon-btn', '⤢');
      ex.title = 'Expand focused pane to full';
      ex.addEventListener('click', function () {
        Promise.resolve(bridge.expandPane(activeId)).then(function (next) { if (next) render(next); });
      });
      tbRight.appendChild(ex);
    }
    if (activePane && activePane.url) {
      var cl = el('button', 'icon-btn', '✕');
      cl.title = 'Close focused session';
      cl.addEventListener('click', function () {
        Promise.resolve(bridge.clearPane(activeId)).then(function (next) { if (next) render(next); });
      });
      tbRight.appendChild(cl);
    }
    var gear = el('button', 'icon-btn', '⚙');
    gear.title = 'Change server';
    gear.addEventListener('click', function () {
      Promise.resolve(bridge.showConnectScreen()).then(function (next) { if (next) render(next); });
    });
    tbRight.appendChild(gear);

    // --- Panes layer: focus accent frame + empty-pane cards (no header strips) ---
    clear(panesLayer);
    var geo = state.geometry;
    if (!geo || !geo.panes) return;
    var multi = geo.panes.length > 1;

    geo.panes.forEach(function (gp) {
      if (gp.active && multi) {
        var frame = el('div', 'pane-frame');
        positionRect(frame, gp.cellRect);
        panesLayer.appendChild(frame);
      }
      if (gp.empty) {
        var empty = el('div', 'pane-empty');
        positionRect(empty, gp.viewBounds);
        var card = el('div', 'pe-card');
        card.appendChild(el('div', 'pe-icon', '🗂'));
        card.appendChild(el('div', 'pe-title', 'Empty pane'));
        var actions = el('div', 'pe-actions');
        var openBtn = el('button', 'pe-btn primary', 'Open a session');
        openBtn.addEventListener('click', function () { openPicker(gp.id); });
        var newBtn = el('button', 'pe-btn', '＋ New session');
        // A new session needs a project — open the picker and let the user hit
        // the "＋" next to a project. (Loading the bare server URL here just
        // dead-ended on "Choose Your Project" with no in-pane sidebar.)
        newBtn.addEventListener('click', function () { openPicker(gp.id); });
        actions.appendChild(openBtn);
        actions.appendChild(newBtn);
        card.appendChild(actions);
        empty.appendChild(card);
        panesLayer.appendChild(empty);
      }
    });
  }

  // ---- Session picker: flat, all sessions grouped by project --------------
  var picker = null;
  var pickerPaneId = null;
  var pickerData = [];   // [{ id, label, sessions:[{id,label,provider,lastActivity}] }]

  function ensurePicker() {
    if (picker) return picker;
    picker = el('div', 'picker-overlay');
    picker.hidden = true;
    picker.innerHTML =
      '<div class="picker-card">' +
      '  <div class="picker-head">' +
      '    <input class="picker-search" type="text" placeholder="Search sessions…" spellcheck="false" />' +
      '    <button class="picker-close" title="Close">✕</button>' +
      '  </div>' +
      '  <div class="picker-list"></div>' +
      '</div>';
    document.body.appendChild(picker);
    picker.addEventListener('click', function (e) { if (e.target === picker) closePicker(false); });
    picker.querySelector('.picker-close').addEventListener('click', function () { closePicker(false); });
    picker.querySelector('.picker-search').addEventListener('input', function (e) { renderList(e.target.value); });
    document.addEventListener('keydown', function (e) {
      if (picker && !picker.hidden && e.key === 'Escape') closePicker(false);
    });
    return picker;
  }

  function openPicker(paneId) {
    pickerPaneId = paneId;
    // Fetch projects + their embedded sessions up front. If not signed in,
    // quietly load the dashboard to log in rather than flashing an error.
    Promise.resolve(bridge.listProjects()).then(function (projects) {
      ensurePicker();
      picker.hidden = false;
      Promise.resolve(bridge.setOverlay(true));
      pickerData = projects || [];
      var s = picker.querySelector('.picker-search');
      s.value = '';
      renderList('');
      setTimeout(function () { s.focus(); }, 30);
    }).catch(function () {
      var pid = paneId;
      Promise.resolve(bridge.setPaneUrl(pid, STATE.serverUrl)).then(function (n) { if (n) render(n); });
    });
  }

  function closePicker(skipReattach) {
    if (picker) picker.hidden = true;
    if (!skipReattach) Promise.resolve(bridge.setOverlay(false));
  }

  function relTime(iso) {
    if (!iso) return '';
    var t = Date.parse(iso);
    if (isNaN(t)) return '';
    var s = (Date.now() - t) / 1000;
    if (s < 60) return 'now';
    if (s < 3600) return Math.floor(s / 60) + 'm';
    if (s < 86400) return Math.floor(s / 3600) + 'h';
    if (s < 604800) return Math.floor(s / 86400) + 'd';
    return Math.floor(s / 604800) + 'w';
  }

  function openInPane(sessionId) {
    var pid = pickerPaneId;
    closePicker(true);
    Promise.resolve(bridge.openSessionInPane(pid, sessionId)).then(function (n) { if (n) render(n); });
  }
  function newInPane(projectId) {
    var pid = pickerPaneId;
    closePicker(true);
    Promise.resolve(bridge.newSessionInPane(pid, projectId)).then(function (n) { if (n) render(n); });
  }

  function renderList(filter) {
    var list = picker.querySelector('.picker-list');
    clear(list);
    var q = (filter || '').toLowerCase();
    var shown = 0;
    pickerData.forEach(function (p) {
      var sessions = (p.sessions || []).filter(function (s) {
        return !q || (s.label || '').toLowerCase().indexOf(q) >= 0;
      });
      if (q && !sessions.length) return;   // hide non-matching groups while searching
      shown += 1;

      var head = el('div', 'pk-group');
      head.appendChild(el('span', 'pk-gname', p.label));
      var add = el('button', 'pk-add', '＋');
      add.title = 'New session in ' + p.label;
      add.addEventListener('click', function (e) { e.stopPropagation(); newInPane(p.id); });
      head.appendChild(add);
      list.appendChild(head);

      if (!sessions.length) {
        list.appendChild(el('div', 'pk-none', 'no sessions yet'));
        return;
      }
      sessions.forEach(function (s) {
        var row = el('button', 'pk-row');
        row.appendChild(el('span', 'pk-dot', '·'));
        row.appendChild(el('span', 'pk-title', s.label || s.id));
        row.appendChild(el('span', 'pk-age', relTime(s.lastActivity)));
        row.addEventListener('click', function () { openInPane(s.id); });
        list.appendChild(row);
      });
    });
    if (!shown) list.innerHTML = '<div class="picker-empty">No matching sessions.</div>';
  }

  // ---- Boot ---------------------------------------------------------------
  function boot() {
    Promise.resolve(bridge.getState()).then(render).catch(function () { render(null); });
    if (bridge.onStateUpdated) bridge.onStateUpdated(render);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
