(function () {
  // --- Client diagnostics -------------------------------------------------
  // The Kindle browser is a black box from the server side. Any script error
  // gets shown on-screen AND posted back so it lands in the server log.
  function reportClient(where, message) {
    try {
      var banner = document.getElementById("errBanner");
      if (!banner) {
        banner = document.createElement("div");
        banner.id = "errBanner";
        banner.style.cssText = "position:fixed;left:0;right:0;bottom:0;z-index:9999;" +
          "background:#7a2a20;color:#fff;font:14px/1.4 sans-serif;padding:8px 10px;" +
          "white-space:pre-wrap;max-height:40%;overflow:auto";
        if (document.body) document.body.appendChild(banner);
      }
      banner.textContent = "[" + where + "] " + message + "\n(tap to dismiss)";
      banner.onclick = function () { banner.style.display = "none"; };
    } catch (e) {}
    try {
      var xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/clientlog", true);
      xhr.setRequestHeader("content-type", "application/json");
      xhr.send(JSON.stringify({ where: where, message: String(message), ua: navigator.userAgent }));
    } catch (e) {}
  }

  window.onerror = function (msg, url, line, col) {
    reportClient("window.onerror", msg + " @" + line + ":" + col);
    return false;
  };
  // ------------------------------------------------------------------------

  var canvas = document.getElementById("ink");
  var wrap = document.querySelector(".canvasWrap");
  var hint = document.getElementById("emptyHint");
  var statusEl = document.getElementById("status");
  var pageText = document.getElementById("pageText");
  var typed = document.getElementById("typed");
  var sendBtn = document.getElementById("sendBtn");
  var clearBtn = document.getElementById("clearBtn");
  var undoBtn = document.getElementById("undoBtn");
  var newBtn = document.getElementById("newBtn");
  var historyBtn = document.getElementById("historyBtn");
  var historyClose = document.getElementById("historyClose");
  var historyPanel = document.getElementById("historyPanel");
  var historyList = document.getElementById("historyList");
  var sessionLabel = document.getElementById("sessionLabel");
  var targetEl = document.getElementById("target");
  var endpointEl = document.getElementById("endpoint");
  var modelEl = document.getElementById("model");
  var tokenEl = document.getElementById("token");
  var strokeWidthEl = document.getElementById("strokeWidth");
  var fastInkEl = document.getElementById("fastInk");
  var streamEl = document.getElementById("streamOn");
  var rotateBtn = document.getElementById("rotateBtn");
  var modeBtn = document.getElementById("modeBtn");
  var pgUp = document.getElementById("pgUp");
  var pgDn = document.getElementById("pgDn");
  var pgUp2 = document.getElementById("pgUp2");
  var pgDn2 = document.getElementById("pgDn2");
  var reply = document.getElementById("reply");

  var landscape = false;
  var mode = "split"; // "split" | "riddle"

  // Where the current reply / thinking / error text goes, per mode.
  function activeOut() {
    return mode === "split" ? reply : pageText;
  }

  var ctx = canvas.getContext("2d");
  var drawing = false;
  var dirty = false;
  var animating = false;
  var last = null;
  var pathEnd = null;
  var queue = [];
  var drawScheduled = false;
  var strokeDrew = false;
  var rectCache = null;
  var strokes = [];
  var currentStroke = null;
  var config = {};

  var sessionId = null;
  var sessionTitle = "";
  var thread = [];
  var viewedSession = null;

  // The Riddle dissolve. Each step is a full-canvas repaint, and on e-ink a
  // repaint is a slow ghosting flash — so FEWER steps look more deliberate and
  // less janky than many. Three is the sweet spot: dark, faded, gone.
  var DISSOLVE = [
    { color: "#6b6558", widthScale: 0.7, dy: 8 },
    { color: "#b3ada0", widthScale: 0.45, dy: 20 },
    { color: "#dcd7c9", widthScale: 0.3, dy: 34 }
  ];
  var DISSOLVE_STEP_MS = 150;
  // Reveal a whole line at a time rather than a few words: on e-ink, each DOM
  // update forces a partial refresh, so 6 updates read far cleaner than 30.
  var REVEAL_WORDS_PER_TICK = 8;
  var REVEAL_TICK_MS = 130;
  var REQUEST_TIMEOUT_MS = 200000;
  var revealGen = 0;
  var thinkGen = 0;
  var RSCHAR = String.fromCharCode(30); // record separator between reply and trailer
  var STREAM_RENDER_MS = 160; // throttle live-stream repaints (e-ink friendly)

  function storageGet(key) {
    try { return window.localStorage.getItem(key); } catch (err) { return null; }
  }
  function storageSet(key, value) {
    try {
      if (value === null) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, value);
    } catch (err) {}
  }

  function setStatus(text) {
    statusEl.innerHTML = text;
  }

  function showHint(show) {
    hint.style.display = show ? "block" : "none";
  }

  // The hint only belongs on a truly blank page: no ink, no formed reply.
  function updateHint() {
    showHint(!dirty && !pageText.innerHTML);
  }

  function escapeHtml(text) {
    return String(text || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function resizeCanvas() {
    rectCache = null;
    // clientWidth/Height are layout values, unaffected by the landscape
    // rotation transform — getBoundingClientRect would swap the axes.
    var w = wrap.clientWidth;
    var h = wrap.clientHeight;
    canvas.width = Math.floor(w);
    canvas.height = Math.floor(h);
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#111";
    ctx.lineWidth = 3.2;
    if (strokes.length) redrawStrokes();
  }

  function inkDataUrl() {
    var maxWidth = 900;
    var sourceWidth = canvas.width;
    var sourceHeight = canvas.height;
    var scale = sourceWidth > maxWidth ? maxWidth / sourceWidth : 1;
    var out = document.createElement("canvas");
    out.width = Math.max(1, Math.floor(sourceWidth * scale));
    out.height = Math.max(1, Math.floor(sourceHeight * scale));
    var outCtx = out.getContext("2d");
    outCtx.fillStyle = "#fbfaf4";
    outCtx.fillRect(0, 0, out.width, out.height);
    outCtx.drawImage(canvas, 0, 0, out.width, out.height);
    return out.toDataURL("image/jpeg", 0.72);
  }

  function firstTouch(event) {
    if (event.touches && event.touches.length) return event.touches[0];
    if (event.changedTouches && event.changedTouches.length) return event.changedTouches[0];
    return event;
  }

  function pointFromEvent(event) {
    if (!rectCache) rectCache = canvas.getBoundingClientRect();
    var rect = rectCache;
    var touch = firstTouch(event);
    var clientX = typeof touch.clientX === "number" ? touch.clientX : touch.pageX - window.pageXOffset;
    var clientY = typeof touch.clientY === "number" ? touch.clientY : touch.pageY - window.pageYOffset;
    if (landscape) {
      // Page is rotated 90° clockwise, so screen axes swap:
      // canvas x runs down the screen, canvas y runs right-to-left.
      return {
        x: clientY - rect.top,
        y: rect.left + rect.width - clientX
      };
    }
    return {
      x: clientX - rect.left,
      y: clientY - rect.top
    };
  }

  function drawDot(point, color) {
    ctx.beginPath();
    ctx.arc(point.x, point.y, ctx.lineWidth / 2, 0, Math.PI * 2, true);
    ctx.fillStyle = color || "#111";
    ctx.fill();
  }

  function midpoint(a, b) {
    return {
      x: (a.x + b.x) / 2,
      y: (a.y + b.y) / 2
    };
  }

  function requestFrame(fn) {
    if (window.requestAnimationFrame) {
      window.requestAnimationFrame(fn);
    } else {
      window.setTimeout(fn, 16);
    }
  }

  function flushQueue() {
    drawScheduled = false;
    if (!last || !queue.length) {
      queue.length = 0;
      return;
    }
    var fast = fastInkEl && fastInkEl.checked;
    ctx.strokeStyle = "#111";
    ctx.lineWidth = Number(strokeWidthEl && strokeWidthEl.value) || 3.5;
    ctx.beginPath();
    ctx.moveTo(pathEnd.x, pathEnd.y);
    var drew = false;
    for (var i = 0; i < queue.length; i += 1) {
      var p = queue[i];
      if (Math.abs(p.x - last.x) + Math.abs(p.y - last.y) < 1.2) continue;
      if (fast) {
        ctx.lineTo(p.x, p.y);
        pathEnd = p;
      } else {
        var mid = midpoint(last, p);
        ctx.quadraticCurveTo(last.x, last.y, mid.x, mid.y);
        pathEnd = mid;
      }
      if (currentStroke) currentStroke.pts.push(p);
      last = p;
      drew = true;
    }
    queue.length = 0;
    if (drew) {
      ctx.stroke();
      strokeDrew = true;
    }
  }

  function drawStoredStroke(stroke, style) {
    var color = (style && style.color) || "#111";
    var widthScale = (style && style.widthScale) || 1;
    var dy = (style && style.dy) || 0;
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(0.6, stroke.width * widthScale);
    var pts = stroke.pts;
    if (pts.length < 2) {
      drawDot({ x: pts[0].x, y: pts[0].y + dy }, color);
      return;
    }
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y + dy);
    var prev = pts[0];
    for (var i = 1; i < pts.length; i += 1) {
      var p = pts[i];
      if (stroke.fast) {
        ctx.lineTo(p.x, p.y + dy);
      } else {
        var mid = midpoint(prev, p);
        ctx.quadraticCurveTo(prev.x, prev.y + dy, mid.x, mid.y + dy);
      }
      prev = p;
    }
    ctx.stroke();
  }

  function redrawStrokes() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (var i = 0; i < strokes.length; i += 1) {
      drawStoredStroke(strokes[i]);
    }
    ctx.strokeStyle = "#111";
    dirty = strokes.length > 0;
    updateHint();
  }

  function undoStroke() {
    if (drawing || animating || !strokes.length) return;
    strokes.pop();
    redrawStrokes();
    setStatus(strokes.length ? "Stroke undone" : "Page blank");
  }

  function dissolveAway(done) {
    animating = true;
    revealGen += 1; // cancel any reveal still ticking
    var step = 0;
    function tick() {
      if (step < DISSOLVE.length) {
        var s = DISSOLVE[step];
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        for (var i = 0; i < strokes.length; i += 1) {
          drawStoredStroke(strokes[i], s);
        }
        pageText.style.color = s.color;
        step += 1;
        window.setTimeout(tick, DISSOLVE_STEP_MS);
        return;
      }
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.strokeStyle = "#111";
      strokes = [];
      currentStroke = null;
      dirty = false;
      pageText.innerHTML = "";
      pageText.style.color = "";
      animating = false;
      done();
    }
    tick();
  }

  function formReply(text) {
    var out = activeOut();
    var words = String(text || "").split(/\s+/);
    var clean = [];
    for (var w = 0; w < words.length; w += 1) {
      if (words[w]) clean.push(words[w]);
    }
    out.innerHTML = "";
    out.style.color = "";
    showHint(false);
    var p = document.createElement("p");
    out.appendChild(p);
    var i = 0;
    revealGen += 1;
    var gen = revealGen;
    function tick() {
      if (gen !== revealGen) return;
      if (i >= clean.length) {
        out.innerHTML = markdownLite(text);
        return;
      }
      var chunk = clean.slice(i, i + REVEAL_WORDS_PER_TICK).join(" ");
      p.appendChild(document.createTextNode((i ? " " : "") + chunk));
      i += REVEAL_WORDS_PER_TICK;
      out.scrollTop = out.scrollHeight;
      window.setTimeout(tick, REVEAL_TICK_MS);
    }
    tick();
  }

  // Slow, e-ink-friendly "thinking" pulse so the page never looks dead while
  // Hermes is working (an ink reply can take minutes). Updates ~once/second.
  function startThinking() {
    var out = activeOut();
    thinkGen += 1;
    var gen = thinkGen;
    var dots = 0;
    out.style.color = "#8a8474";
    out.innerHTML = '<p class="thinking">Hermes is thinking</p>';
    var el = out.firstChild;
    function tick() {
      if (gen !== thinkGen) return;
      dots = (dots + 1) % 4;
      el.textContent = "Hermes is thinking" + new Array(dots + 1).join(" .");
      window.setTimeout(tick, 900);
    }
    window.setTimeout(tick, 900);
  }

  function stopThinking() {
    thinkGen += 1;
  }

  function showPageError(message) {
    var out = activeOut();
    stopThinking();
    revealGen += 1;
    out.style.color = "#7a2a20";
    out.innerHTML = "<p><strong>Couldn't reach Hermes.</strong></p><p>" +
      escapeHtml(message) + "</p><p>Your writing is still there — tap Send to try again.</p>";
  }

  function schedulePoint(point) {
    queue.push(point);
    if (!drawScheduled) {
      drawScheduled = true;
      requestFrame(flushQueue);
    }
  }

  function stopEvent(event) {
    if (event.preventDefault) event.preventDefault();
    if (event.stopPropagation) event.stopPropagation();
    event.returnValue = false;
    return false;
  }

  function start(event) {
    // Let the on-page scroll buttons receive their clicks.
    var t = event.target || event.srcElement;
    if (t && (t.tagName === "BUTTON" || (t.parentNode && t.parentNode.className === "pageCtl"))) {
      return true;
    }
    if (animating) return stopEvent(event);
    warm(); // pen touched paper — start waking the model now
    // Riddle behavior: pen touching the page makes the old words vanish.
    if (pageText.innerHTML) {
      revealGen += 1;
      pageText.innerHTML = "";
      pageText.style.color = "";
    }
    if (event.pointerId !== undefined && wrap.setPointerCapture) {
      try { wrap.setPointerCapture(event.pointerId); } catch (err) {}
    }
    rectCache = canvas.getBoundingClientRect();
    last = pointFromEvent(event);
    pathEnd = last;
    queue.length = 0;
    strokeDrew = false;
    currentStroke = {
      width: Number(strokeWidthEl && strokeWidthEl.value) || 3.5,
      fast: !!(fastInkEl && fastInkEl.checked),
      pts: [last]
    };
    strokes.push(currentStroke);
    drawing = true;
    dirty = true;
    showHint(false);
    return stopEvent(event);
  }

  function move(event) {
    if (!drawing) return stopEvent(event);
    if (event.getCoalescedEvents) {
      var coalesced = event.getCoalescedEvents();
      for (var i = 0; i < coalesced.length; i += 1) {
        schedulePoint(pointFromEvent(coalesced[i]));
      }
      if (!coalesced.length) schedulePoint(pointFromEvent(event));
    } else {
      schedulePoint(pointFromEvent(event));
    }
    return stopEvent(event);
  }

  function end(event) {
    if (!drawing) return stopEvent(event);
    flushQueue();
    if (!strokeDrew && last) {
      ctx.lineWidth = Number(strokeWidthEl && strokeWidthEl.value) || 3.5;
      drawDot(last);
    }
    drawing = false;
    last = null;
    pathEnd = null;
    currentStroke = null;
    queue.length = 0;
    drawScheduled = false;
    return stopEvent(event);
  }

  function clearInk() {
    if (animating) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    strokes = [];
    currentStroke = null;
    dirty = false;
    updateHint();
    setStatus("Ready");
  }

  function markdownLite(text) {
    var escaped = String(text || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    var lines = escaped.split(/\r?\n/);
    var html = "";
    var inList = false;
    for (var i = 0; i < lines.length; i += 1) {
      var line = lines[i];
      var item = line.match(/^\s*[-*]\s+(.+)/);
      if (item) {
        if (!inList) {
          html += "<ul>";
          inList = true;
        }
        html += "<li>" + item[1] + "</li>";
      } else {
        if (inList) {
          html += "</ul>";
          inList = false;
        }
        if (line.replace(/\s/g, "")) html += "<p>" + line + "</p>";
      }
    }
    if (inList) html += "</ul>";
    return html || "<p>No response text.</p>";
  }

  function renderLatest() {
    var lastReply = null;
    for (var i = thread.length - 1; i >= 0; i -= 1) {
      if (thread[i].role === "assistant") {
        lastReply = thread[i];
        break;
      }
    }
    revealGen += 1;
    stopThinking();
    var out = activeOut();
    var other = out === reply ? pageText : reply;
    out.style.color = "";
    out.innerHTML = lastReply
      ? markdownLite(lastReply.text)
      : (out === reply ? "<p>Hermes replies will appear here.</p>" : "");
    if (other) other.innerHTML = "";
    sessionLabel.innerHTML = thread.length
      ? "Entry: " + escapeHtml(sessionTitle || "Untitled")
      : "New entry";
    updateHint();
  }

  function threadHtml(messages) {
    var html = "";
    for (var i = 0; i < messages.length; i += 1) {
      var m = messages[i];
      html += '<div class="turn">';
      if (m.role === "user") {
        html += '<p class="who">You</p>';
        if (m.text) html += markdownLite(m.text);
        if (m.ink) html += '<img class="inkThumb" src="' + m.ink + '" alt="handwritten entry">';
      } else {
        html += '<p class="who">Hermes</p>';
        html += markdownLite(m.text);
      }
      html += "</div>";
    }
    return html || "<p>No messages.</p>";
  }

  function ajaxJson(method, url, payload, callback, timeoutMs) {
    var xhr = new XMLHttpRequest();
    var done = false;
    function finish(err, json) {
      if (done) return;
      done = true;
      callback(err, json);
    }
    xhr.open(method, url, true);
    xhr.setRequestHeader("content-type", "application/json");
    if (timeoutMs) xhr.timeout = timeoutMs;
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) return;
      var json = null;
      try {
        json = JSON.parse(xhr.responseText);
      } catch (error) {
        finish(new Error("Bad response: " + xhr.responseText.slice(0, 200)));
        return;
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        finish(new Error((json && json.error) || "HTTP " + xhr.status));
        return;
      }
      finish(null, json);
    };
    xhr.onerror = function () {
      finish(new Error("Network error — is the Hermes server awake and reachable?"));
    };
    xhr.ontimeout = function () {
      finish(new Error("Hermes took too long to answer. Try again, or a shorter note."));
    };
    xhr.send(payload ? JSON.stringify(payload) : null);
  }

  // Pre-warm: wake the model in the background so Send doesn't hit cold start.
  // Fires on page open and when the pen first touches paper — both are well
  // before the actual send, and it's debounced so it can't spam the gateway.
  var lastWarm = 0;
  function warm() {
    var now = (new Date()).getTime();
    if (now - lastWarm < 45000) return;
    lastWarm = now;
    try {
      var x = new XMLHttpRequest();
      x.open("POST", "/api/warm", true);
      x.setRequestHeader("content-type", "application/json");
      x.send("{}");
    } catch (e) {}
  }

  function loadConfig() {
    ajaxJson("GET", "/api/config", null, function (error, json) {
      if (error) {
        setStatus("Ready, config unavailable");
        return;
      }
      config = json || {};
      endpointEl.setAttribute("placeholder", config.hermesEndpoint || "");
      modelEl.setAttribute("placeholder", config.defaultTextModel || "");
      setStatus("Ready");
    });
  }

  function newEntry() {
    if (animating) return;
    sessionId = null;
    sessionTitle = "";
    thread = [];
    storageSet("diarySessionId", null);
    clearInk();
    typed.value = "";
    renderLatest();
    hideHistory();
    setStatus("New entry");
  }

  // Body class carries BOTH orientation and mode, so set them together.
  function syncBodyClass() {
    var cls = [];
    if (landscape) cls.push("landscape");
    if (mode === "split") cls.push("split");
    document.body.className = cls.join(" ");
  }

  function applyLandscape(on) {
    landscape = !!on;
    syncBodyClass();
    storageSet("diaryLandscape", landscape ? "1" : null);
    rectCache = null;
    // Give the browser one frame to relayout before measuring the canvas.
    requestFrame(function () {
      resizeCanvas();
      setStatus(landscape ? "Landscape — turn the Kindle so its top edge is on the left" : "Portrait");
    });
  }

  function toggleLandscape() {
    applyLandscape(!landscape);
  }

  function applyMode(m) {
    mode = m === "riddle" ? "riddle" : "split";
    if (modeBtn) modeBtn.textContent = mode === "split" ? "Mode: Split" : "Mode: Riddle";
    storageSet("diaryMode", mode);
    syncBodyClass();
    rectCache = null;
    requestFrame(function () {
      resizeCanvas();
      renderLatest(); // re-show the latest reply in the newly active pane
    });
  }

  function toggleMode() {
    applyMode(mode === "split" ? "riddle" : "split");
  }

  function pageScroll(direction) {
    var out = activeOut();
    var step = Math.max(120, Math.floor(out.clientHeight * 0.8)) * direction;
    out.scrollTop += step;
  }

  function shortDate(iso) {
    if (!iso) return "";
    return iso.slice(0, 10) + " " + iso.slice(11, 16);
  }

  function renderHistoryList(items) {
    if (!items.length) {
      historyList.innerHTML = "<p>No entries yet.</p>";
      return;
    }
    var html = "";
    for (var i = 0; i < items.length; i += 1) {
      var s = items[i];
      html += '<div class="historyItem" data-id="' + escapeHtml(s.id) + '">';
      html += '<div class="meta"><strong>' + escapeHtml(s.title) + "</strong>";
      html += "<span>" + shortDate(s.updatedAt) + " &middot; " + Math.floor(s.count / 2) + " sends &middot; " + escapeHtml(s.preview) + "</span></div>";
      html += '<button type="button" data-open="' + escapeHtml(s.id) + '">Open</button>';
      html += '<button type="button" data-del="' + escapeHtml(s.id) + '">Del</button>';
      html += "</div>";
    }
    historyList.innerHTML = html;
  }

  function refreshHistory() {
    viewedSession = null;
    historyList.innerHTML = "<p>Loading&hellip;</p>";
    ajaxJson("GET", "/api/sessions", null, function (error, json) {
      if (error) {
        historyList.innerHTML = "<p>" + escapeHtml(error.message) + "</p>";
        return;
      }
      renderHistoryList(json.sessions || []);
    });
  }

  function showSessionLog(id) {
    historyList.innerHTML = "<p>Loading&hellip;</p>";
    ajaxJson("GET", "/api/sessions/" + encodeURIComponent(id), null, function (error, json) {
      if (error) {
        historyList.innerHTML = "<p>" + escapeHtml(error.message) + "</p>";
        return;
      }
      viewedSession = json.session;
      var html = '<div class="logActions">';
      html += '<button type="button" data-back="1">Back</button>';
      html += '<button type="button" data-continue="' + escapeHtml(viewedSession.id) + '">Continue this entry</button>';
      html += "</div>";
      html += "<h2>" + escapeHtml(viewedSession.title || "Untitled entry") + "</h2>";
      html += threadHtml(viewedSession.messages || []);
      historyList.innerHTML = html;
    });
  }

  function continueSession(id) {
    if (!viewedSession || viewedSession.id !== id) return;
    sessionId = viewedSession.id;
    sessionTitle = viewedSession.title;
    thread = viewedSession.messages || [];
    storageSet("diarySessionId", sessionId);
    renderLatest();
    hideHistory();
    setStatus("Entry loaded");
  }

  function hideHistory() {
    historyPanel.hidden = true;
    historyPanel.style.display = "none";
  }

  function toggleHistory() {
    var visible = historyPanel.style.display === "block";
    if (visible) {
      hideHistory();
      return;
    }
    historyPanel.hidden = false;
    historyPanel.style.display = "block";
    refreshHistory();
  }

  function activateSession(id) {
    ajaxJson("GET", "/api/sessions/" + encodeURIComponent(id), null, function (error, json) {
      if (error) {
        renderLatest();
        return;
      }
      var s = json.session;
      sessionId = s.id;
      sessionTitle = s.title;
      thread = s.messages || [];
      renderLatest();
    });
  }

  function deleteSession(id) {
    ajaxJson("POST", "/api/sessions/" + encodeURIComponent(id) + "/delete", {}, function (error) {
      if (error) {
        setStatus(escapeHtml(error.message));
        return;
      }
      if (id === sessionId) {
        sessionId = null;
        sessionTitle = "";
        thread = [];
        storageSet("diarySessionId", null);
        renderLatest();
      }
      refreshHistory();
    });
  }

  function historyClick(event) {
    var target = event.target || event.srcElement;
    if (!target || !target.getAttribute) return;
    var openId = target.getAttribute("data-open");
    var delId = target.getAttribute("data-del");
    var contId = target.getAttribute("data-continue");
    if (target.getAttribute("data-back")) refreshHistory();
    else if (openId) showSessionLog(openId);
    else if (delId) deleteSession(delId);
    else if (contId) continueSession(contId);
  }

  function requestPayload() {
    var target = targetEl.value;
    var endpoint = endpointEl.value.replace(/^\s+|\s+$/g, "");
    var model = modelEl.value.replace(/^\s+|\s+$/g, "");
    return {
      target: target,
      endpoint: target === "custom" || target === "hermes" ? endpoint : "",
      model: model,
      token: tokenEl.value.replace(/^\s+|\s+$/g, ""),
      text: typed.value.replace(/^\s+|\s+$/g, ""),
      imageDataUrl: dirty ? inkDataUrl() : "",
      sessionId: sessionId
    };
  }

  function setBusy(busy) {
    sendBtn.disabled = busy;
    clearBtn.disabled = busy;
    undoBtn.disabled = busy;
    newBtn.disabled = busy;
  }

  function send() {
    try {
      sendInner();
    } catch (err) {
      reportClient("send", (err && err.message) || String(err));
      setBusy(false);
      setStatus("Send crashed");
    }
  }

  function clearCanvasNow() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = "#111";
    strokes = [];
    currentStroke = null;
    dirty = false;
    updateHint();
  }

  function sendInner() {
    if (animating) return;
    var payload = requestPayload();
    if (!payload.text && !payload.imageDataUrl) {
      setStatus("Write or type something first");
      return;
    }
    setBusy(true);
    setStatus("Sending");

    // Snapshot the ink so a failure can resurface exactly what was written.
    var savedStrokes = strokes.slice();
    var savedInk = payload.imageDataUrl;

    if (streamEl && streamEl.checked) {
      streamSend(payload, savedStrokes, savedInk);
      return;
    }

    var replyText = null;
    var failed = null;
    var isRiddle = mode === "riddle";
    // Riddle waits for the dissolve animation to finish before showing the
    // reply; split has no animation, so it's ready to react immediately.
    var ready = !isRiddle;

    function restoreInk() {
      strokes = savedStrokes;
      redrawStrokes();
    }

    function clearCanvas() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.strokeStyle = "#111";
      strokes = [];
      currentStroke = null;
      dirty = false;
      updateHint();
    }

    function onError() {
      showPageError(failed);
      restoreInk();
      setBusy(false);
      setStatus("Error");
    }

    function finishReply() {
      stopThinking();
      // Split mode keeps the ink up during thinking, then clears it once the
      // reply lands so the top is fresh for the next note (and not re-sent).
      if (mode === "split") clearCanvas();
      formReply(replyText);
      setBusy(false);
      setStatus("Reply from Hermes");
    }

    function proceed() {
      if (!ready) return;
      if (failed !== null) onError();
      else if (replyText !== null) finishReply();
      else startThinking();
    }

    if (isRiddle) {
      // The dissolve runs while the request is in flight, masking latency.
      dissolveAway(function () {
        ready = true;
        proceed();
      });
    } else {
      // Split: keep the writing visible, show the pulse in the reply pane.
      startThinking();
    }

    ajaxJson("POST", "/api/send", payload, function (error, json) {
      if (error || !json.ok) {
        failed = (error && error.message) || json.error || "Send failed";
        proceed();
        return;
      }
      sessionId = json.sessionId;
      sessionTitle = json.title || sessionTitle;
      storageSet("diarySessionId", sessionId);
      thread.push({ role: "user", text: payload.text, ink: savedInk });
      thread.push({ role: "assistant", text: json.text });
      typed.value = "";
      sessionLabel.innerHTML = "Entry: " + escapeHtml(sessionTitle || "Untitled");
      replyText = json.text;
      proceed();
    }, REQUEST_TIMEOUT_MS);
  }

  // Live streaming: read the reply incrementally as Hermes writes it, using
  // XHR readyState 3 (LOADING) — the one streaming path old WebKit supports.
  function streamSend(payload, savedStrokes, savedInk) {
    var isRiddle = mode === "riddle";
    var gen = ++revealGen;               // cancels any prior reveal/stream
    var revealReady = !isRiddle;         // riddle waits for the dissolve
    var metaParsed = false;
    var headerEnd = 0;
    var streamText = "";
    var trailer = null;
    var errMsg = null;
    var finished = false;
    var renderPending = false;

    payload.stream = true;

    function restoreInk() {
      strokes = savedStrokes;
      redrawStrokes();
    }

    function paint(finalize) {
      if (gen !== revealGen || !revealReady) return;
      stopThinking();
      var out = activeOut();
      out.style.color = "";
      if (finalize) {
        out.innerHTML = markdownLite(streamText);
      } else {
        // Plain text while streaming is cheap; markdown only at the end.
        out.textContent = streamText;
      }
      out.scrollTop = out.scrollHeight;
    }

    function scheduleRender() {
      if (renderPending) return;
      renderPending = true;
      window.setTimeout(function () {
        renderPending = false;
        paint(false);
      }, STREAM_RENDER_MS);
    }

    function parse() {
      var txt = xhr.responseText;
      if (!metaParsed) {
        var nl = txt.indexOf("\n");
        if (nl < 0) return;
        try {
          var meta = JSON.parse(txt.slice(0, nl));
          if (meta && meta.sessionId) sessionId = meta.sessionId;
        } catch (e) {}
        metaParsed = true;
        headerEnd = nl + 1;
      }
      var bodyPart = txt.slice(headerEnd);
      var rs = bodyPart.indexOf(RSCHAR);
      if (rs >= 0) {
        streamText = bodyPart.slice(0, rs);
        try {
          trailer = JSON.parse(bodyPart.slice(rs + 1));
        } catch (e) {}
      } else {
        streamText = bodyPart;
      }
    }

    function finishStream() {
      if (finished || gen !== revealGen) return;
      finished = true;
      stopThinking();
      if (!errMsg && xhr.status && (xhr.status < 200 || xhr.status >= 300)) {
        errMsg = "HTTP " + xhr.status;
      }
      if (trailer && trailer.error) errMsg = trailer.error;
      if (errMsg) {
        showPageError(errMsg);
        restoreInk();
        setBusy(false);
        setStatus("Error");
        return;
      }
      if (trailer && trailer.title) sessionTitle = trailer.title;
      storageSet("diarySessionId", sessionId);
      thread.push({ role: "user", text: payload.text, ink: savedInk });
      thread.push({ role: "assistant", text: streamText });
      typed.value = "";
      sessionLabel.innerHTML = "Entry: " + escapeHtml(sessionTitle || "Untitled");
      if (mode === "split") clearCanvasNow();
      paint(true);
      setBusy(false);
      setStatus("Reply from Hermes");
    }

    var xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/send", true);
    xhr.setRequestHeader("content-type", "application/json");
    xhr.timeout = REQUEST_TIMEOUT_MS;
    xhr.onreadystatechange = function () {
      if (gen !== revealGen) return;
      if (xhr.readyState >= 3 && xhr.responseText) {
        parse();
        scheduleRender();
      }
      if (xhr.readyState === 4) finishStream();
    };
    xhr.onerror = function () {
      errMsg = "Network error — is the Hermes server awake and reachable?";
      finishStream();
    };
    xhr.ontimeout = function () {
      errMsg = "Hermes took too long to answer. Try again, or a shorter note.";
      finishStream();
    };

    if (isRiddle) {
      dissolveAway(function () {
        revealReady = true;
        // The reply may already be complete (fast reply during the dissolve),
        // still streaming, or not started yet — handle each.
        if (finished) paint(true);
        else if (streamText) paint(false);
        else startThinking();
      });
    } else {
      startThinking();
    }

    try {
      xhr.send(JSON.stringify(payload));
    } catch (err) {
      errMsg = (err && err.message) || "Could not send";
      finishStream();
    }
  }

  function add(el, name, fn) {
    if (el.addEventListener) el.addEventListener(name, fn, false);
    else if (el.attachEvent) el.attachEvent("on" + name, fn);
  }

  function bindInkEvents(el) {
    if (window.PointerEvent) {
      add(el, "pointerdown", start);
      add(el, "pointermove", move);
      add(el, "pointerup", end);
      add(el, "pointercancel", end);
      add(el, "pointerleave", end);
    } else if (window.MSPointerEvent) {
      add(el, "MSPointerDown", start);
      add(el, "MSPointerMove", move);
      add(el, "MSPointerUp", end);
    } else if ("ontouchstart" in window) {
      add(el, "touchstart", start);
      add(el, "touchmove", move);
      add(el, "touchend", end);
      add(el, "touchcancel", end);
    } else {
      add(el, "mousedown", start);
      add(el, "mousemove", move);
      add(el, "mouseup", end);
      add(el, "mouseleave", end);
      add(document, "mouseup", end);
    }
  }

  bindInkEvents(wrap);
  add(window, "resize", resizeCanvas);
  add(clearBtn, "click", clearInk);
  add(undoBtn, "click", undoStroke);
  add(sendBtn, "click", send);
  add(newBtn, "click", newEntry);
  add(historyBtn, "click", toggleHistory);
  add(historyClose, "click", hideHistory);
  add(historyList, "click", historyClick);
  add(rotateBtn, "click", toggleLandscape);
  add(modeBtn, "click", toggleMode);
  add(pgUp, "click", function () { pageScroll(-1); });
  add(pgDn, "click", function () { pageScroll(1); });
  add(pgUp2, "click", function () { pageScroll(-1); });
  add(pgDn2, "click", function () { pageScroll(1); });

  // Apply saved mode + orientation before first paint.
  mode = storageGet("diaryMode") === "riddle" ? "riddle" : "split";
  landscape = storageGet("diaryLandscape") === "1";
  if (modeBtn) modeBtn.textContent = mode === "split" ? "Mode: Split" : "Mode: Riddle";
  if (streamEl) {
    streamEl.checked = storageGet("diaryStream") !== "0";
    add(streamEl, "change", function () {
      storageSet("diaryStream", streamEl.checked ? "1" : "0");
    });
  }
  syncBodyClass();

  resizeCanvas();
  showHint(true);
  setStatus("Ready");
  loadConfig();
  warm(); // wake the model on open
  hideHistory();

  var savedSession = storageGet("diarySessionId");
  if (savedSession) activateSession(savedSession);
  else renderLatest();
}());
