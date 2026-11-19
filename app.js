/*
 * =====================================================================
 *  Promo Share Tracker — faculty share page (GitHub Pages)
 *  Flow: read ?t=TOKEN → GET init → render cards → preload each media
 *  file as Blob → File → enable "Share to WhatsApp Status" → on tap call
 *  navigator.share() synchronously (fresh user gesture) → log result.
 *  All logging is fire-and-forget through a localStorage retry queue.
 *  No frameworks, no external requests except the API and media files.
 * =====================================================================
 */
(function () {
  'use strict';

  var CFG = window.PROMO_CONFIG || {};
  var API = String(CFG.API_URL || '').trim();
  var QKEY = 'promo_share_queue_v1';
  var token = (new URLSearchParams(location.search).get('t') || '').trim();
  var env = detectEnv();
  var state = { data: null, files: {}, urls: {}, noText: {}, unsupportedLogged: {}, flushing: false };
  var memQueue = []; // fallback when localStorage is blocked

  /* ------------------------------------------------------------------
   * Environment detection (device / browser / share capability)
   * ---------------------------------------------------------------- */
  function detectEnv() {
    var ua = navigator.userAgent || '';
    var isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    var isAndroid = /Android/i.test(ua);
    var device = isIOS ? 'iOS' : (isAndroid ? 'Android' : 'Desktop');
    var inApp = /FBAN|FBAV|FB_IAB|FBIOS|Instagram|Line\/|Snapchat|Twitter|LinkedInApp|WhatsApp|; wv\)|GSA\/|MicroMessenger/i.test(ua);
    var browser = 'other';
    if (/WhatsApp/i.test(ua)) browser = 'WhatsApp in-app';
    else if (isIOS) {
      if (/CriOS/.test(ua)) browser = 'Chrome';
      else if (!inApp && /Safari\//.test(ua) && !/FxiOS|EdgiOS|OPiOS/.test(ua)) browser = 'Safari';
    } else if (/Chrome\/\d+/.test(ua) && !/Edg\/|OPR\/|SamsungBrowser|; wv\)|YaBrowser|UCBrowser/.test(ua)) browser = 'Chrome';
    else if (/Safari\//.test(ua) && /Version\//.test(ua) && !/Chrome|Android/.test(ua)) browser = 'Safari';
    var m = ua.match(/OS (\d+)_\d+/);
    var iosVersion = isIOS && m ? parseInt(m[1], 10) : 0;
    return {
      device: device, browser: browser, inApp: inApp, isIOS: isIOS, isAndroid: isAndroid, iosVersion: iosVersion,
      shareApi: typeof navigator.share === 'function' && typeof navigator.canShare === 'function'
    };
  }

  /* ------------------------------------------------------------------
   * Small DOM helpers
   * ---------------------------------------------------------------- */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function esc(v) {
    return String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function app(html) { $('#app').innerHTML = html; window.scrollTo(0, 0); }
  var toastTimer;
  function toast(msg, ms) {
    var t = $('#toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, ms || 3500);
  }

  /* ------------------------------------------------------------------
   * Screens
   * ---------------------------------------------------------------- */
  function screenLoading(msg) {
    app('<div class="center"><div class="spinner" aria-hidden="true"></div><p>' + esc(msg || 'Loading…') + '</p></div>');
  }
  function screenInvalid(msg) {
    app('<div class="card center-card"><div class="big-icon">🔒</div><h1>Link not valid</h1><p>' +
      esc(msg || 'This link is not valid. Please contact your HOD.') + '</p></div>');
  }
  function screenError(msg) {
    app('<div class="card center-card"><div class="big-icon">📶</div><h1>Could not connect</h1><p>' + esc(msg) +
      '</p><button class="btn primary" id="retry">↻ Retry</button></div>');
    $('#retry').addEventListener('click', start);
  }
  function screenNoItems(d) {
    app(welcomeHtml(d) + '<div class="card center-card"><div class="big-icon">🙏</div><h1>No promotion item today.</h1><p>Thank you!</p>' +
      '<p class="muted small">Please check again tomorrow.</p></div>');
  }

  function welcomeHtml(d) {
    var dt = new Date();
    var dateStr = dt.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' });
    return '<section class="welcome"><div class="hello">Welcome, <b>' + esc(d.faculty.name) + '</b></div>' +
      '<div class="muted small">' + esc(d.faculty.dept) + ' · ' + esc(dateStr) + '</div></section>';
  }

  function guideHtml() {
    return '<section class="guide" aria-label="How to share">' +
      '<div class="step"><span class="n">1</span><span class="i">📤</span><span>Tap <b>Share</b></span></div>' +
      '<div class="step"><span class="n">2</span><span class="i wa">✆</span><span>Choose <b>WhatsApp</b></span></div>' +
      '<div class="step"><span class="n">3</span><span class="i">◎</span><span>Choose <b>“My status”</b></span></div>' +
      '<div class="step"><span class="n">4</span><span class="i">➤</span><span>Tap <b>Send</b></span></div>' +
      '</section>';
  }

  /** Hint for browsers that cannot share files (desktop, in-app, old iOS) */
  function envHint() {
    if (env.device === 'Desktop') {
      return '<div class="hint warn">💻 Sharing to WhatsApp Status works only on your <b>phone</b>. Open this same link on your phone ' +
        '(send it to yourself on WhatsApp). You can still download the file below.</div>';
    }
    if (env.inApp && !env.shareApi) {
      return '<div class="hint warn">🌐 This page is open inside another app. For the Share button, open it in ' +
        (env.isIOS ? '<b>Safari</b>: tap <b>•••</b> or the compass icon → <b>Open in Safari</b>.' : '<b>Chrome</b>: tap <b>⋮</b> (top-right) → <b>Open in Chrome</b>.') +
        '<br><button class="link-btn" id="copy-page">Copy this page link</button></div>';
    }
    if (env.isIOS && env.iosVersion && env.iosVersion < 15) {
      return '<div class="hint warn">📱 Your iPhone software is old (iOS ' + env.iosVersion + '). Update to iOS 15 or later for the Share button, ' +
        'or use <b>Download</b> and post from WhatsApp → Status.</div>';
    }
    if (!env.shareApi) {
      return '<div class="hint warn">This browser cannot share files. Open the link in <b>' + (env.isIOS ? 'Safari' : 'Chrome') +
        '</b>, or use <b>Download</b> and post from WhatsApp → Status.</div>';
    }
    return '';
  }

  /* ------------------------------------------------------------------
   * Start-up
   * ---------------------------------------------------------------- */
  function start() {
    $('#logo').textContent = CFG.LOGO_TEXT || 'GCE';
    $('#college').textContent = CFG.COLLEGE_NAME || '';
    if (CFG.HELP_TEXT) $('#foot').textContent = CFG.HELP_TEXT;
    if (!API || API.indexOf('PASTE_') === 0) { screenError('Setup incomplete: the API URL is missing in config.js.'); return; }
    if (!/^[A-Za-z0-9]{8,32}$/.test(token)) { screenInvalid(); return; }
    screenLoading('Loading today\'s promotion…');
    getInit(2).then(function (d) {
      if (!d || !d.ok) {
        if (d && d.error === 'invalid_token') screenInvalid(d.message);
        else screenError((d && d.error) || 'Unexpected response from server.');
        return;
      }
      state.data = d;
      if (d.college) { $('#college').textContent = d.college; document.title = 'Share · ' + d.college; }
      render(d);
      flushQueue();
    }).catch(function () {
      screenError('Please check your internet connection and try again.');
    });
  }

  function getInit(tries) {
    var url = API + (API.indexOf('?') === -1 ? '?' : '&') + 'action=init&t=' + encodeURIComponent(token) + '&_=' + Date.now();
    return fetchJson(url, { method: 'GET', redirect: 'follow' }, 25000).catch(function (err) {
      if (tries > 1) return wait(1500).then(function () { return getInit(tries - 1); });
      throw err;
    });
  }

  function fetchJson(url, opts, timeoutMs) {
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    if (ctrl) opts.signal = ctrl.signal;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, timeoutMs || 20000);
    return fetch(url, opts).then(function (r) {
      clearTimeout(timer);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }, function (e) { clearTimeout(timer); throw e; });
  }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* ------------------------------------------------------------------
   * Main render
   * ---------------------------------------------------------------- */
  function render(d) {
    if (!d.items || !d.items.length) { screenNoItems(d); return; }
    var html = welcomeHtml(d) + envHint() + guideHtml();
    d.items.forEach(function (it) { html += cardHtml(it); });
    if (d.proofEnabled) html += proofHtml(d);
    html += '<p class="note small">“Shared ✓” means you completed the share. Please make sure you chose <b>My status</b>. Thank you for supporting our admissions! 🙏</p>';
    app(html);

    var cp = $('#copy-page');
    if (cp) cp.addEventListener('click', function () { copy(location.href); });

    // page_open — one log call for all visible items
    log('page_open', d.items.map(function (i) { return i.itemCode; }));

    d.items.forEach(function (it) { bindCard(it); });
    if (d.proofEnabled) bindProof(d);
    preloadSequential(d.items.slice());
  }

  function cardHtml(it) {
    var id = 'c-' + it.itemCode;
    return '<article class="card item" id="' + esc(id) + '">' +
      '<div class="media"><div class="placeholder"><div class="spinner small" aria-hidden="true"></div><span>Preparing ' +
      (it.type === 'video' ? 'video' : 'poster') + '…</span></div></div>' +
      '<div class="body">' +
      '<div class="row"><span class="tag">' + (it.type === 'video' ? '🎬 Video' : '🖼️ Poster') + '</span>' +
      '<span class="badge-shared"' + (it.sharedByMe ? '' : ' hidden') + '>Shared ✓</span></div>' +
      '<h2>' + esc(it.title) + '</h2>' +
      (it.caption ? '<p class="caption">' + esc(it.caption).replace(/\n/g, '<br>') + '</p>' +
        '<button class="link-btn copy-cap" type="button">📋 Copy caption</button>' : '') +
      '<button class="btn share" type="button" disabled>Preparing… </button>' +
      '<a class="btn download" role="button" href="' + esc(it.mediaUrl) + '" download>⬇ Download</a>' +
      '<p class="msg" role="status"></p>' +
      '</div></article>';
  }

  function cardEl(it) { return document.getElementById('c-' + it.itemCode); }
  function setMsg(it, html, cls) {
    var m = $('.msg', cardEl(it));
    m.className = 'msg' + (cls ? ' ' + cls : '');
    m.innerHTML = html || '';
  }

  function bindCard(it) {
    var card = cardEl(it);
    $('.share', card).addEventListener('click', function () { onShare(it); });
    $('.download', card).addEventListener('click', function () { log('download', it.itemCode); });
    var cc = $('.copy-cap', card);
    if (cc) cc.addEventListener('click', function () { copy(it.caption); });
  }

  /* ------------------------------------------------------------------
   * Preload media → File (so the share call needs no await)
   * ---------------------------------------------------------------- */
  function preloadSequential(items) {
    if (!items.length) return;
    var it = items.shift();
    preload(it, false).then(function () { preloadSequential(items); });
  }

  function guessMime(it) {
    var ext = String(it.mediaUrl || '').split('?')[0].split('.').pop().toLowerCase();
    if (ext === 'png') return 'image/png';
    if (ext === 'mp4') return 'video/mp4';
    return it.type === 'video' ? 'video/mp4' : 'image/jpeg';
  }
  function extFor(mime) { return mime === 'image/png' ? 'png' : mime === 'video/mp4' ? 'mp4' : 'jpg'; }

  function fetchWithProgress(url, onPct) {
    return fetch(url, { redirect: 'follow' }).then(function (r) {
      if (!r.ok) { var e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
      var total = parseInt(r.headers.get('content-length') || '0', 10);
      if (!r.body || !r.body.getReader || !total) return r.blob();
      var reader = r.body.getReader(), got = 0, chunks = [];
      var type = r.headers.get('content-type') || '';
      function pump() {
        return reader.read().then(function (res) {
          if (res.done) return new Blob(chunks, { type: type });
          chunks.push(res.value); got += res.value.length;
          onPct(Math.min(99, Math.round(got * 100 / total)));
          return pump();
        });
      }
      return pump();
    });
  }

  function preload(it, bustCache) {
    var card = cardEl(it);
    var btn = $('.share', card);
    btn.disabled = true;
    btn.textContent = 'Preparing…';
    setMsg(it, '');
    var url = it.mediaUrl + (bustCache ? (it.mediaUrl.indexOf('?') === -1 ? '?' : '&') + 'r=' + Date.now() : '');
    return fetchWithProgress(url, function (p) { btn.textContent = 'Preparing… ' + p + '%'; })
      .then(function (blob) {
        var mime = (blob.type && /^(image|video)\//.test(blob.type)) ? blob.type.split(';')[0] : guessMime(it);
        var typed = new Blob([blob], { type: mime });
        var name = 'Admission_' + it.itemCode + '.' + extFor(mime);
        var file = new File([typed], name, { type: mime, lastModified: Date.now() });
        state.files[it.itemCode] = file;
        if (state.urls[it.itemCode]) URL.revokeObjectURL(state.urls[it.itemCode]);
        var objUrl = state.urls[it.itemCode] = URL.createObjectURL(typed);

        $('.media', card).innerHTML = mime.indexOf('video') === 0
          ? '<video src="' + objUrl + '" controls playsinline preload="metadata"></video>'
          : '<img src="' + objUrl + '" alt="' + esc(it.title) + '">';
        var dl = $('.download', card);
        dl.href = objUrl; dl.setAttribute('download', name);

        var can = false;
        try { can = env.device !== 'Desktop' && env.shareApi && navigator.canShare({ files: [file] }); } catch (e) { can = false; }
        if (can) {
          btn.disabled = false;
          btn.textContent = it.sharedByMe ? '↻ Share again to WhatsApp Status' : '📤 Share to WhatsApp Status';
        } else {
          markUnsupported(it);
        }
      })
      .catch(function (err) {
        var notYet = err && err.status === 404;
        btn.textContent = 'Media not ready';
        $('.media', card).innerHTML = '<div class="placeholder">' + (notYet ? '⏳ Media is being published' : '⚠️ Could not load media') + '</div>';
        setMsg(it, (notYet
          ? 'This new poster/video is still being published. Please wait about a minute and tap Retry.'
          : 'Could not download the file. Check your internet and tap Retry.') +
          ' <button class="link-btn retry" type="button">↻ Retry</button>', 'warn');
        $('.retry', card).addEventListener('click', function () { preload(it, true); });
      });
  }

  function markUnsupported(it) {
    var card = cardEl(it);
    var btn = $('.share', card);
    btn.disabled = true;
    btn.textContent = 'Share not available here';
    var tip = env.device === 'Desktop' ? 'Open this link on your phone to share to WhatsApp Status.'
      : env.inApp ? 'Open this page in ' + (env.isIOS ? 'Safari' : 'Chrome') + ' to use Share — or Download and post from WhatsApp → Status.'
        : 'Your browser cannot share files. Use <b>Download</b>, then open WhatsApp → Status → add the file.';
    setMsg(it, tip, 'warn');
    if (!state.unsupportedLogged[it.itemCode]) {
      state.unsupportedLogged[it.itemCode] = true;
      log('share_unsupported', it.itemCode);
    }
  }

  /* ------------------------------------------------------------------
   * Share — navigator.share() is called synchronously inside the click
   * handler (no await before it) to keep the fresh user gesture.
   * ---------------------------------------------------------------- */
  function onShare(it) {
    var file = state.files[it.itemCode];
    if (!file) return;
    var data = { files: [file] };
    if (it.caption && !state.noText[it.itemCode]) data.text = it.caption;
    var p;
    try {
      p = navigator.share(data);
    } catch (err) {
      shareError(it, err);
      return;
    }
    p.then(function () {
      log('share_success', it.itemCode);
      it.sharedByMe = true;
      var card = cardEl(it);
      $('.badge-shared', card).hidden = false;
      $('.share', card).textContent = '↻ Share again to WhatsApp Status';
      setMsg(it, '✅ Shared — thank you! Please make sure it went to <b>My status</b>.', 'ok');
      toast('Shared ✓ Thank you!');
    }).catch(function (err) { shareError(it, err); });
  }

  function shareError(it, err) {
    var name = err && err.name;
    if (name === 'AbortError') {
      log('share_cancel', it.itemCode);
      setMsg(it, 'Share cancelled. Tap Share again when you are ready.');
      return;
    }
    if (name === 'TypeError' || name === 'DataError') {
      // some phones refuse file + text together → retry with the file only
      if (!state.noText[it.itemCode] && it.caption) {
        state.noText[it.itemCode] = true;
        setMsg(it, 'Please tap Share once more. (The caption can be pasted using “Copy caption”.)', 'warn');
        return;
      }
    }
    if (name === 'NotAllowedError') {
      setMsg(it, 'Your phone blocked the share. Tap the Share button once (not twice). If it keeps failing, use Download.', 'warn');
      return;
    }
    log('share_unsupported', it.itemCode);
    setMsg(it, 'Sharing failed on this browser. Use <b>Download</b>, then open WhatsApp → Status → add the file.', 'warn');
  }

  /* ------------------------------------------------------------------
   * Proof upload (optional): compress to max 1280 px, JPEG 0.7
   * ---------------------------------------------------------------- */
  function proofHtml(d) {
    return '<section class="card proof" id="proof"><h2>📸 Upload evening views screenshot</h2>' +
      '<p class="muted small">In the evening open WhatsApp → <b>Updates/Status</b> → <b>My status</b> → tap 👁 to see the views. Take a screenshot and upload it here.</p>' +
      '<label class="lbl">Item<select id="pf-item">' + d.items.map(function (i) {
        return '<option value="' + esc(i.itemCode) + '">' + esc(i.title) + '</option>';
      }).join('') + '</select></label>' +
      '<label class="lbl">Views count<input id="pf-views" type="number" inputmode="numeric" min="0" max="10000000" placeholder="e.g. 85"></label>' +
      '<label class="lbl">Screenshot<input id="pf-file" type="file" accept="image/*"></label>' +
      '<img id="pf-preview" class="pf-preview" alt="" hidden>' +
      '<button class="btn primary" id="pf-send" type="button">⬆ Upload proof</button>' +
      '<p class="msg" id="pf-msg" role="status"></p></section>';
  }

  function bindProof() {
    var compressed = null;
    $('#pf-file').addEventListener('change', function (e) {
      var f = e.target.files[0];
      compressed = null;
      $('#pf-preview').hidden = true;
      if (!f) return;
      if (!/^image\//.test(f.type) && !/\.(jpe?g|png|webp|heic|heif)$/i.test(f.name)) { proofMsg('Please choose an image.', 'warn'); return; }
      proofMsg('Preparing image…');
      compressImage(f, 1280, 0.7).then(function (dataUrl) {
        compressed = dataUrl;
        $('#pf-preview').src = dataUrl; $('#pf-preview').hidden = false;
        proofMsg('Ready (' + Math.round(dataUrl.length * 0.75 / 1024) + ' KB).');
      }).catch(function () { proofMsg('Could not read this image. Try a normal screenshot (JPG/PNG).', 'warn'); });
    });
    $('#pf-send').addEventListener('click', function () {
      var views = parseInt($('#pf-views').value, 10);
      if (isNaN(views) || views < 0) { proofMsg('Please enter the views count.', 'warn'); return; }
      if (!compressed) { proofMsg('Please choose the screenshot.', 'warn'); return; }
      var btn = $('#pf-send');
      btn.disabled = true; btn.textContent = 'Uploading…';
      postJson({
        action: 'proof', t: token, itemCode: $('#pf-item').value, views: views,
        imageBase64: compressed.split(',')[1], device: env.device, browser: env.browser
      }).then(function (r) {
        if (r && r.ok) {
          proofMsg('✅ Uploaded. Thank you!', 'ok');
          $('#pf-file').value = ''; $('#pf-views').value = ''; $('#pf-preview').hidden = true; compressed = null;
        } else proofMsg((r && (r.message || r.error)) || 'Upload failed.', 'warn');
      }).catch(function () {
        proofMsg('Network problem — please try again.', 'warn');
      }).then(function () { btn.disabled = false; btn.textContent = '⬆ Upload proof'; });
    });
  }
  function proofMsg(t, cls) { var m = $('#pf-msg'); m.className = 'msg' + (cls ? ' ' + cls : ''); m.textContent = t; }

  function compressImage(file, maxSide, quality) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var w = img.naturalWidth, h = img.naturalHeight;
        var scale = Math.min(1, maxSide / Math.max(w, h));
        var c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(w * scale)); c.height = Math.max(1, Math.round(h * scale));
        var g = c.getContext('2d');
        g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
        g.drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL('image/jpeg', quality));
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('decode')); };
      img.src = url;
    });
  }

  /* ------------------------------------------------------------------
   * Logging — fire-and-forget with a localStorage retry queue
   * ---------------------------------------------------------------- */
  function readQ() {
    try { return JSON.parse(localStorage.getItem(QKEY) || '[]'); } catch (e) { return memQueue.slice(); }
  }
  function writeQ(q) {
    var cutoff = Date.now() - 70 * 3600 * 1000; // server accepts events up to 72 h old
    q = q.filter(function (x) { return x.clientTs > cutoff; }).slice(-200);
    try { localStorage.setItem(QKEY, JSON.stringify(q)); } catch (e) { memQueue = q; }
  }

  function log(event, itemCodes) {
    var p = { action: 'log', t: token, event: event, device: env.device, browser: env.browser, clientTs: Date.now(),
      qid: Date.now().toString(36) + Math.random().toString(36).slice(2, 8) };
    if (Array.isArray(itemCodes)) p.itemCodes = itemCodes; else p.itemCode = itemCodes;
    var q = readQ(); q.push(p); writeQ(q);
    flushQueue();
  }

  function flushQueue() {
    if (state.flushing || !API) return;
    var q = readQ();
    if (!q.length) return;
    state.flushing = true;
    var item = q[0];
    postJson(item).then(function (r) {
      // Server answered: remove the event (ok, or a permanent error such as unknown item).
      // Keep it only when the server was temporarily busy.
      if (r && r.ok === false && /busy|try again/i.test(r.error || '')) throw new Error('busy');
      writeQ(readQ().filter(function (x) { return x.qid !== item.qid; }));
      state.flushing = false;
      flushQueue();
    }).catch(function () {
      state.flushing = false; // network problem → retry later
    });
  }

  function postJson(payload) {
    // text/plain avoids the CORS pre-flight; Apps Script reads e.postData.contents
    return fetchJson(API, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
      redirect: 'follow'
    }, 30000);
  }

  window.addEventListener('online', flushQueue);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') flushQueue(); });
  setInterval(flushQueue, 30000);

  /* ------------------------------------------------------------------
   * Clipboard
   * ---------------------------------------------------------------- */
  function copy(text) {
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      var ok = false; try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      ta.remove();
      toast(ok ? 'Copied ✓' : 'Copy failed — long-press to copy');
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast('Copied ✓'); }, fallback);
    } else fallback();
  }

  // Go!
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
