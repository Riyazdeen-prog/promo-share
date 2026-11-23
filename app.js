/*
 * =====================================================================
 *  Promo Share Tracker — faculty share page (GitHub Pages)
 *  Flow: read ?t=TOKEN → GET init → render cards → preload each media
 *  file as Blob → File → enable "Share to WhatsApp Status" → on tap call
 *  navigator.share() synchronously (fresh user gesture) → log result.
 *  All logging is fire-and-forget through a localStorage retry queue.
 *  Notices: a sticky notice bar under the header (rotates / scrolls)
 *  and a bottom-sheet list with "Mark as done" for task notices.
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
    app(welcomeHtml(d) + '<div class="card center-card"><div class="big-icon">📭</div><h1>No promotion item today.</h1><p>Thank you!</p>' +
      '<p class="muted small">Please check again tomorrow.</p></div>');
  }

  function welcomeHtml(d) {
    var dt = new Date();
    var dateStr = dt.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' });
    return '<section class="welcome"><div class="hello">Welcome, <b>' + esc(d.faculty.name) + '</b></div>' +
      '<div class="muted small">' + esc(d.faculty.dept) + ' · ' + esc(dateStr) + '</div>' +
      '<div class="daily-note" style="margin-top:10px;padding:10px 12px;border-radius:10px;background:#fff7e0;border:1px solid #f2d68a;color:#5a4300;font-size:13.5px;line-height:1.5">' +
      '📢 Check daily at 5 PM for today’s WhatsApp status poster.<br>' +
      'Your cooperation and support are highly appreciated.</div></section>';
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
      initNotices(d.notices);
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
    html += '<p class="note small">“Shared ✓” means you completed the share. Please make sure you chose <b>My status</b>. Thank you for supporting our admissions! 💐</p>';
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
   * Notices — sticky bar under the header + bottom-sheet list
   *  • one notice at a time: short text stays still ~5 s, long text
   *    scrolls slowly (≈45 px/s) after a 1.6 s pause, then the next one
   *  • urgent first; task notices leave the bar once marked done
   *  • tap the bar → full list; "Mark as done" needs a second tap
   *  • prefers-reduced-motion → no scrolling, no fades
   *  • "seen" / "done" go through the same offline retry queue as logs
   * ---------------------------------------------------------------- */
  var NKEY = 'promo_notice_v1';
  var NPRI = {
    urgent: { label: 'Urgent', icon: '⚠️' },
    important: { label: 'Important', icon: '📌' },
    info: { label: 'Info', icon: 'ℹ️' }
  };
  var reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  var NB = { list: [], bar: [], i: 0, timers: [], paused: false, open: false, armed: null, armTimer: null, me: null, bound: false, memStore: {} };

  function nLoadMe() {
    var all;
    try { all = JSON.parse(localStorage.getItem(NKEY) || '{}') || {}; } catch (e) { all = NB.memStore; }
    var me = all[token] || {};
    ['opened', 'seen', 'done'].forEach(function (k) { if (!me[k] || typeof me[k] !== 'object') me[k] = {}; });
    return me;
  }
  function nSaveMe() {
    var ids = {};
    NB.list.forEach(function (n) { ids[n.id] = true; });
    ['opened', 'seen', 'done'].forEach(function (k) {   // forget notices that are no longer live
      Object.keys(NB.me[k]).forEach(function (id) { if (!ids[id]) delete NB.me[k][id]; });
    });
    var all;
    try { all = JSON.parse(localStorage.getItem(NKEY) || '{}') || {}; } catch (e) { all = NB.memStore; }
    all[token] = NB.me;
    try { localStorage.setItem(NKEY, JSON.stringify(all)); } catch (e) { NB.memStore = all; }
  }

  function nQueue(event, noticeId) {
    var p = { action: 'notice', t: token, event: event, noticeId: noticeId, device: env.device, clientTs: Date.now(),
      qid: Date.now().toString(36) + Math.random().toString(36).slice(2, 8) };
    var q = readQ(); q.push(p); writeQ(q);
    flushQueue();
  }
  function nMarkSeen(n) {
    if (NB.me.seen[n.id]) return;
    NB.me.seen[n.id] = Date.now();
    nSaveMe();
    nQueue('seen', n.id);
  }

  function dueLabel(d) {
    if (d === null || d === undefined || d === '') return '';
    d = Number(d);
    if (d <= 0) return 'Ends today';
    if (d === 1) return 'Ends tomorrow';
    return d + ' days left';
  }
  function nIsOpenTask(n) { return !(n.needsAck && n.done); }

  function initNotices(list) {
    var bar = $('#nbar');
    if (!bar || !$('#nsheet')) return;   // old cached index.html without the notice markup
    NB.list = (Array.isArray(list) ? list : []).filter(function (n) { return n && n.id && n.message; });
    nClear();
    if (!NB.list.length) { bar.hidden = true; bar.innerHTML = ''; return; }
    NB.me = nLoadMe();
    NB.list.forEach(function (n) { if (NB.me.done[n.id]) n.done = true; });   // done offline, not yet synced
    nSaveMe();
    bar.hidden = false;
    nBindOnce();
    nPosition();
    nBuildBar();
    // A new urgent task opens the list once by itself
    var urgentNew = NB.list.some(function (n) { return n.priority === 'urgent' && !NB.me.opened[n.id] && nIsOpenTask(n); });
    if (urgentNew) nLater(function () { if (!NB.open) openSheet(); }, 900);
  }

  function nPosition() {
    var h = $('.top');
    $('#nbar').style.top = (h ? h.offsetHeight : 0) + 'px';
  }

  function nNewCount() {
    return NB.list.filter(function (n) { return !NB.me.opened[n.id]; }).length;
  }

  function nBuildBar() {
    var bar = $('#nbar');
    NB.bar = NB.list.filter(nIsOpenTask);
    var nNew = nNewCount();
    var chip = nNew ? '<span class="nbar-chip" id="nbar-chip">' + nNew + ' new</span>'
      : '<span class="nbar-chip soft" id="nbar-chip">' + (NB.list.length > 1 ? 'View all ' + NB.list.length : 'View') + '</span>';

    if (!NB.bar.length) {   // every task is done → calm green bar
      bar.className = 'nbar p-alldone';
      bar.innerHTML = '<button type="button" class="nbar-btn" id="nbar-btn" aria-haspopup="dialog" aria-controls="nsheet" ' +
        'aria-label="All tasks done. Open notices">' +
        '<span class="nbar-ic" aria-hidden="true">✅</span><span class="nbar-track"><span class="nbar-text' + (reduceMotion ? ' still' : '') + '">All tasks done — thank you!</span></span>' +
        chip + '</button>';
      return;
    }
    var dots = '';
    if (NB.bar.length > 1 && NB.bar.length <= 8) {
      dots = '<div class="nbar-dots" aria-hidden="true">' + NB.bar.map(function () { return '<i></i>'; }).join('') + '</div>';
    }
    bar.innerHTML = '<button type="button" class="nbar-btn" id="nbar-btn" aria-haspopup="dialog" aria-controls="nsheet">' +
      '<span class="nbar-ic" aria-hidden="true"></span>' +
      '<span class="nbar-track"><span class="nbar-text' + (reduceMotion ? ' still' : '') + '" id="nbar-text"></span></span>' +
      chip + '</button>' + dots;
    if (NB.i >= NB.bar.length) NB.i = 0;
    nShow(NB.i, true);
  }

  function nLater(fn, ms) { NB.timers.push(setTimeout(fn, ms)); }
  function nClear() { NB.timers.forEach(clearTimeout); NB.timers = []; }

  function nShow(i, instant) {
    nClear();
    if (!NB.bar.length || !$('#nbar-text')) return;
    NB.i = (i + NB.bar.length) % NB.bar.length;
    var n = NB.bar[NB.i];
    var txt = $('#nbar-text');
    function apply() {
      var pri = NPRI[n.priority] || NPRI.info;
      var bar = $('#nbar');
      bar.className = 'nbar p-' + (NPRI[n.priority] ? n.priority : 'info');
      var ic = $('.nbar-ic', bar);
      ic.textContent = pri.icon;
      ic.className = 'nbar-ic' + (n.priority === 'urgent' && !reduceMotion ? ' pulse' : '');
      txt.style.transition = 'none';
      txt.style.transform = 'translateX(0)';
      txt.textContent = n.message;
      txt.classList.remove('fade');
      var dots = bar.querySelectorAll('.nbar-dots i');
      for (var k = 0; k < dots.length; k++) dots[k].className = k === NB.i ? 'on' : '';
      var due = dueLabel(n.daysLeft);
      $('#nbar-btn').setAttribute('aria-label', (NB.bar.length > 1 ? 'Notice ' + (NB.i + 1) + ' of ' + NB.bar.length + '. ' : '') +
        pri.label + ': ' + n.message + (due ? '. ' + due : '') + '. Tap to open all notices.');
      nMarkSeen(n);
      nRun();
    }
    if (instant || reduceMotion) apply();
    else { txt.classList.add('fade'); nLater(apply, 300); }
  }

  function nRun() {
    if (NB.paused || NB.open) return;
    var track = $('.nbar-track'), txt = $('#nbar-text');
    if (!track || !txt) return;
    var multi = NB.bar.length > 1;
    var over = txt.scrollWidth - track.clientWidth;
    if (over > 4 && !reduceMotion) {
      var secs = Math.max(2, over / 45);
      nLater(function () {
        txt.style.transition = 'transform ' + secs.toFixed(2) + 's linear';
        txt.style.transform = 'translateX(' + (-over) + 'px)';
        nLater(function () { nShow(NB.i + (multi ? 1 : 0)); }, secs * 1000 + 1800);
      }, 1600);
    } else if (multi) {
      nLater(function () { nShow(NB.i + 1); }, reduceMotion ? 6000 : 5000);
    }
  }

  function nPause() { NB.paused = true; nClear(); }
  function nResume() {
    NB.paused = false;
    if (!NB.open && NB.bar.length) nShow(NB.i, true);
  }

  /* ---------------- bottom sheet ---------------- */
  function ncardHtml(n) {
    var pri = NPRI[n.priority] || NPRI.info;
    var isNew = !NB.me.opened[n.id];
    var due = dueLabel(n.daysLeft);
    var done = n.needsAck && n.done;
    var link = /^https:\/\//i.test(n.linkUrl || '')
      ? '<a class="nbtn link" href="' + esc(n.linkUrl) + '" target="_blank" rel="noopener noreferrer">' + esc(n.linkText || 'Open') + ' ↗</a>' : '';
    var act = '';
    if (n.needsAck) {
      act = done ? '<span class="ndone">✅ Done — thank you</span>'
        : '<button type="button" class="nbtn done" data-nid="' + esc(n.id) + '">✓ Mark as done</button>';
    }
    return '<article class="ncard p-' + esc(NPRI[n.priority] ? n.priority : 'info') + (done ? ' is-done' : '') + '" id="nc-' + esc(n.id) + '">' +
      '<div class="ncard-top"><span class="npri">' + pri.icon + ' ' + pri.label + '</span>' +
      (isNew ? '<span class="nnew">New</span>' : '') +
      (due && !done ? '<span class="ndue' + (Number(n.daysLeft) <= 0 ? ' late' : '') + '">⏰ ' + esc(due) + '</span>' : '') + '</div>' +
      '<h3>' + esc(n.message) + '</h3>' +
      (n.details ? '<p class="ndet">' + esc(n.details) + '</p>' : '') +
      (link || act ? '<div class="nact">' + link + act + '</div>' : '') +
      '</article>';
  }

  function renderSheet() {
    var open = NB.list.filter(nIsOpenTask), done = NB.list.filter(function (n) { return !nIsOpenTask(n); });
    $('#nsheet-body').innerHTML = open.concat(done).map(ncardHtml).join('') +
      '<p class="nsheet-foot">Notices from the Admission Cell · tap ✕ or swipe down to close</p>';
  }

  function openSheet() {
    if (NB.open || !NB.list.length) return;
    NB.open = true;
    nClear();
    renderSheet();   // "New" labels show this one time
    $('#nsheet').hidden = false;
    document.body.classList.add('nsheet-open');
    NB.lastFocus = document.activeElement;
    setTimeout(function () { var x = $('#nsheet-x'); if (x) x.focus(); }, 60);
    var changed = false;
    NB.list.forEach(function (n) {
      if (!NB.me.opened[n.id]) { NB.me.opened[n.id] = Date.now(); changed = true; }
      nMarkSeen(n);
    });
    if (changed) nSaveMe();
  }

  function closeSheet() {
    if (!NB.open) return;
    NB.open = false;
    nDisarm();
    var sh = $('.nsheet');
    sh.style.transition = ''; sh.style.transform = '';
    $('#nsheet').hidden = true;
    document.body.classList.remove('nsheet-open');
    NB.paused = document.visibilityState === 'hidden';
    nBuildBar();   // new count, finished tasks leave the bar
    if (NB.lastFocus && NB.lastFocus.focus) { try { NB.lastFocus.focus({ preventScroll: true }); } catch (e) { /* old browsers */ } }
  }

  function nDisarm() {
    clearTimeout(NB.armTimer);
    if (NB.armed) {
      var b = document.querySelector('.nbtn.done.confirm');
      if (b) { b.classList.remove('confirm'); b.textContent = '✓ Mark as done'; }
    }
    NB.armed = null;
  }

  function onMarkDone(btn) {
    var id = btn.getAttribute('data-nid');
    if (NB.armed !== id) {   // first tap: ask to confirm (avoids accidental taps)
      nDisarm();
      NB.armed = id;
      btn.classList.add('confirm');
      btn.textContent = 'Tap again to confirm';
      NB.armTimer = setTimeout(nDisarm, 4000);
      return;
    }
    nDisarm();
    var n = NB.list.filter(function (x) { return x.id === id; })[0];
    if (!n) return;
    n.done = true;
    NB.me.done[id] = Date.now();
    nSaveMe();
    nQueue('done', id);
    var card = document.getElementById('nc-' + id);
    if (card) card.outerHTML = ncardHtml(n);
    toast('✅ Marked as done — thank you!');
  }

  function nBindOnce() {
    if (NB.bound) return;
    NB.bound = true;
    $('#nbar').addEventListener('click', function (e) { if (e.target.closest('#nbar-btn')) openSheet(); });
    $('#nsheet-x').addEventListener('click', closeSheet);
    $('#nsheet').addEventListener('click', function (e) { if (e.target.id === 'nsheet') closeSheet(); });
    $('#nsheet-body').addEventListener('click', function (e) {
      var b = e.target.closest('.nbtn.done');
      if (b) onMarkDone(b);
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && NB.open) closeSheet(); });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') nPause(); else nResume();
    });
    var rt;
    window.addEventListener('resize', function () {
      clearTimeout(rt);
      rt = setTimeout(function () { nPosition(); if (!NB.open && !NB.paused) nShow(NB.i, true); }, 200);
    });

    // swipe down on the sheet to close
    var sheet = $('.nsheet'), body = $('#nsheet-body'), y0 = null, dy = 0;
    sheet.addEventListener('touchstart', function (e) {
      var fromBody = body.contains(e.target);
      y0 = (!fromBody || body.scrollTop <= 0) ? e.touches[0].clientY : null;
      dy = 0;
      sheet.style.transition = 'none';
    }, { passive: true });
    sheet.addEventListener('touchmove', function (e) {
      if (y0 === null) return;
      dy = e.touches[0].clientY - y0;
      if (dy > 0) { sheet.style.transform = 'translateY(' + dy + 'px)'; if (e.cancelable) e.preventDefault(); }
      else { sheet.style.transform = ''; }
    }, { passive: false });
    sheet.addEventListener('touchend', function () {
      sheet.style.transition = '';
      if (y0 !== null && dy > 90) closeSheet(); else sheet.style.transform = '';
      y0 = null; dy = 0;
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
