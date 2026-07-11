(function () {
  // --- Optional shared-secret auth ----------------------------------------
  // If the bridge sets DIARY_AUTH_TOKEN, open the diary with ?k=<token> once;
  // we stash it and send it on every API call. Harmless when no token is set.
  var authTok = "";
  var remoteKey = "";
  (function () {
    var m = (window.location.search || "").match(/[?&]k=([^&#]+)/);
    var rm = (window.location.search || "").match(/[?&]rk=([^&#]+)/);
    var rpm = (window.location.pathname || "").match(/^\/remote\/([^/]+)\/?$/);
    if (rm) remoteKey = decodeURIComponent(rm[1]);
    else if (rpm) remoteKey = decodeURIComponent(rpm[1]);
    try {
      if (m) { authTok = decodeURIComponent(m[1]); window.localStorage.setItem("diaryAuth", authTok); }
      else { authTok = window.localStorage.getItem("diaryAuth") || ""; }
    } catch (e) {}
  }());
  function setAuth(xhr) {
    if (authTok) { try { xhr.setRequestHeader("x-diary-auth", authTok); } catch (e) {} }
    if (remoteKey) { try { xhr.setRequestHeader("x-diary-remote-key", remoteKey); } catch (e) {} }
  }

  function secureMediaUrl(url) {
    if (!remoteKey || !url) return url;
    return url + (url.indexOf("?") >= 0 ? "&" : "?") + "rk=" + encodeURIComponent(remoteKey);
  }

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
      setAuth(xhr);
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
  var strokeWidthValueEl = document.getElementById("strokeWidthValue");
  var fastInkEl = document.getElementById("fastInk");
  var streamEl = document.getElementById("streamOn");
  var rotateBtn = document.getElementById("rotateBtn");
  var pgUp = document.getElementById("pgUp");
  var pgDn = document.getElementById("pgDn");
  var pgUp2 = document.getElementById("pgUp2");
  var pgDn2 = document.getElementById("pgDn2");
  var reply = document.getElementById("reply");
  var replyToggle = document.getElementById("replyToggle");
  var zoomInBtn = document.getElementById("zoomIn");
  var zoomOutBtn = document.getElementById("zoomOut");
  var panBtn = document.getElementById("panBtn");
  var resetViewBtn = document.getElementById("resetView");
  var eraserBtn = document.getElementById("eraserBtn");
  var lassoBtn = document.getElementById("lassoBtn");
  var copyBtn = document.getElementById("copyBtn");
  var pasteBtn = document.getElementById("pasteBtn");
  var rotateSelectionBtn = document.getElementById("rotateSelectionBtn");

  var landscape = false;
  var darkMode = false;

  // On-screen ink flips with the theme (light strokes on dark paper). The
  // EXPORT (inkDataUrl) always draws black-on-cream for handwriting OCR.
  function inkColor() {
    return darkMode ? "#e9e7e0" : "#111";
  }

  function activeOut() {
    return reply;
  }

  var ctx = canvas.getContext("2d");
  var drawing = false;
  var dirty = false;
  var last = null;
  var pathEnd = null;
  var queue = [];
  var drawScheduled = false;
  var strokeDrew = false;
  var rectCache = null;
  var strokes = [];
  var currentStroke = null;
  var historyActions = [];
  var eraserMode = false;
  var erasing = false;
  var currentEraseAction = null;
  var lassoMode = false;
  var lassoing = false;
  var lassoPoints = [];
  var selectedStrokes = [];
  var selectionClipboard = [];
  var movingSelection = false;
  var selectionDragStart = null;
  var selectionDragOriginal = null;
  var config = {};

  // Pan/zoom: strokes are stored in "world" coordinates. The visible canvas is
  // a window into that world at `view.scale`, offset by (view.ox, view.oy).
  //   worldPoint  = canvasPx / scale + offset
  //   canvasPx    = (worldPoint - offset) * scale
  var view = { scale: 1, ox: 0, oy: 0 };
  var MIN_SCALE = 0.4;
  var MAX_SCALE = 5;
  var panMode = false;
  var panning = false;
  var panStartScreen = null;
  var panStartOffset = null;

  function applyView() {
    ctx.setTransform(view.scale, 0, 0, view.scale, -view.ox * view.scale, -view.oy * view.scale);
  }

  function resetView() {
    view.scale = 1;
    view.ox = 0;
    view.oy = 0;
    applyView();
  }

  function setScale(newScale) {
    newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, newScale));
    var cw = canvas.width, ch = canvas.height;
    // Keep the world point currently at the canvas center fixed while zooming.
    var wcx = (cw / 2) / view.scale + view.ox;
    var wcy = (ch / 2) / view.scale + view.oy;
    view.scale = newScale;
    view.ox = wcx - (cw / 2) / newScale;
    view.oy = wcy - (ch / 2) / newScale;
    applyView();
    redrawStrokes();
    setStatus("Zoom " + Math.round(newScale * 100) + "%");
  }

  function zoomIn() { setScale(view.scale * 1.25); }
  function zoomOut() { setScale(view.scale / 1.25); }

  function resetViewAndRedraw() {
    resetView();
    redrawStrokes();
    setStatus("View reset");
  }

  function togglePan() {
    panMode = !panMode;
    if (panMode) { setEraserMode(false); setLassoMode(false); }
    if (panBtn) panBtn.className = panMode ? "active" : "";
    setStatus(panMode ? "Pan mode — drag to move the page" : "Draw mode");
  }

  function setEraserMode(enabled) {
    eraserMode = !!enabled;
    if (eraserMode) setLassoMode(false);
    if (eraserBtn) eraserBtn.className = eraserMode ? "active" : "";
  }

  function setLassoMode(enabled) {
    lassoMode = !!enabled;
    lassoing = false;
    lassoPoints = [];
    if (lassoMode) {
      eraserMode = false;
      panMode = false;
      if (eraserBtn) eraserBtn.className = "";
      if (panBtn) panBtn.className = "";
    }
    if (lassoBtn) lassoBtn.className = lassoMode ? "active" : "";
    if (!lassoMode) selectedStrokes = [];
    syncSelectionButtons();
    redrawStrokes();
  }

  function toggleLasso() {
    setLassoMode(!lassoMode);
    setStatus(lassoMode ? "Lasso: circle ink, then hold and drag" : "Pen mode");
  }

  function toggleEraser() {
    setEraserMode(!eraserMode);
    if (eraserMode) {
      panMode = false;
      if (panBtn) panBtn.className = "";
    }
    setStatus(eraserMode ? "Eraser mode - drag across ink" : "Pen mode");
  }

  var sessionId = null;
  var hermesThreadId = null;
  var sessionTitle = "";
  var thread = [];
  var viewedSession = null;

  // The Riddle dissolve. Each step is a full-canvas repaint, and on e-ink a
  // repaint is a slow ghosting flash — so FEWER steps look more deliberate and
  // less janky than many. Three is the sweet spot: dark, faded, gone.
  // Reveal a whole line at a time rather than a few words: on e-ink, each DOM
  // update forces a partial refresh, so 6 updates read far cleaner than 30.
  var REVEAL_WORDS_PER_TICK = 8;
  var REVEAL_TICK_MS = 130;
  var REQUEST_TIMEOUT_MS = 200000;
  var revealGen = 0;
  var thinkGen = 0;
  var RSCHAR = String.fromCharCode(30); // record separator between reply and trailer
  var STREAM_RENDER_MS = 160; // throttle live-stream repaints (e-ink friendly)
  var STALE_SESSION_MS = 3 * 3600 * 1000; // resume an entry only if <3h old
  var LONG_THREAD = 16; // exchanges after which we nudge toward a fresh entry

  function newHermesThreadId() {
    return "kindle-" + (new Date()).getTime().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }

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
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = inkColor();
    ctx.lineWidth = 3.2;
    applyView();
    if (strokes.length) redrawStrokes();
  }

  function inkDataUrl() {
    // Export ALL strokes across the whole world, not just the visible viewport,
    // so Hermes sees everything written regardless of the current zoom/pan.
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var i = 0; i < strokes.length; i += 1) {
      var pts = strokes[i].pts;
      for (var j = 0; j < pts.length; j += 1) {
        if (pts[j].x < minX) minX = pts[j].x;
        if (pts[j].x > maxX) maxX = pts[j].x;
        if (pts[j].y < minY) minY = pts[j].y;
        if (pts[j].y > maxY) maxY = pts[j].y;
      }
    }
    if (!isFinite(minX)) {
      // No strokes — fall back to the current viewport in world coords.
      minX = view.ox; minY = view.oy;
      maxX = view.ox + canvas.width / view.scale;
      maxY = view.oy + canvas.height / view.scale;
    }
    var pad = 24;
    minX -= pad; minY -= pad; maxX += pad; maxY += pad;
    var worldW = Math.max(1, maxX - minX);
    var worldH = Math.max(1, maxY - minY);
    var maxDim = 1400;
    var s = Math.min(1, maxDim / Math.max(worldW, worldH));
    var out = document.createElement("canvas");
    out.width = Math.max(1, Math.round(worldW * s));
    out.height = Math.max(1, Math.round(worldH * s));
    var outCtx = out.getContext("2d");
    outCtx.fillStyle = "#fbfaf4";
    outCtx.fillRect(0, 0, out.width, out.height);
    outCtx.lineCap = "round";
    outCtx.lineJoin = "round";
    outCtx.strokeStyle = "#111";
    outCtx.fillStyle = "#111";
    outCtx.setTransform(s, 0, 0, s, -minX * s, -minY * s);
    for (var k = 0; k < strokes.length; k += 1) {
      drawStrokeInto(outCtx, strokes[k]);
    }
    return out.toDataURL("image/jpeg", 0.8);
  }

  function firstTouch(event) {
    if (event.touches && event.touches.length) return event.touches[0];
    if (event.changedTouches && event.changedTouches.length) return event.changedTouches[0];
    return event;
  }

  // Canvas-pixel coordinates (landscape rotation applied), before pan/zoom.
  function canvasPointFromEvent(event) {
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

  // World coordinates (what strokes are stored in): undo the pan/zoom.
  function pointFromEvent(event) {
    var c = canvasPointFromEvent(event);
    return { x: c.x / view.scale + view.ox, y: c.y / view.scale + view.oy };
  }

  function drawDot(point, color) {
    ctx.beginPath();
    ctx.arc(point.x, point.y, ctx.lineWidth / 2, 0, Math.PI * 2, true);
    ctx.fillStyle = color || inkColor();
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
    ctx.strokeStyle = inkColor();
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

  // Build a stroke's path into any context `c`, in world coordinates.
  function buildStrokePath(c, stroke, dy) {
    var pts = stroke.pts;
    c.beginPath();
    c.moveTo(pts[0].x, pts[0].y + dy);
    var prev = pts[0];
    for (var i = 1; i < pts.length; i += 1) {
      var p = pts[i];
      if (stroke.fast) {
        c.lineTo(p.x, p.y + dy);
      } else {
        var mid = midpoint(prev, p);
        c.quadraticCurveTo(prev.x, prev.y + dy, mid.x, mid.y + dy);
      }
      prev = p;
    }
    c.stroke();
  }

  function drawStoredStroke(stroke, style) {
    var color = (style && style.color) || inkColor();
    var widthScale = (style && style.widthScale) || 1;
    var dy = (style && style.dy) || 0;
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(0.6, stroke.width * widthScale);
    if (stroke.pts.length < 2) {
      drawDot({ x: stroke.pts[0].x, y: stroke.pts[0].y + dy }, color);
      return;
    }
    buildStrokePath(ctx, stroke, dy);
  }

  // Draw a stroke into an export context (no dissolve style, no view transform).
  function drawStrokeInto(c, stroke) {
    c.lineWidth = Math.max(0.6, stroke.width);
    var pts = stroke.pts;
    if (pts.length < 2) {
      c.beginPath();
      c.arc(pts[0].x, pts[0].y, c.lineWidth / 2, 0, Math.PI * 2, true);
      c.fill();
      return;
    }
    buildStrokePath(c, stroke, 0);
  }

  function clearScreen() {
    // Clear the whole physical canvas regardless of the current view transform.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    applyView();
  }

  function redrawStrokes() {
    clearScreen();
    for (var i = 0; i < strokes.length; i += 1) {
      drawStoredStroke(strokes[i]);
    }
    drawSelectionOverlay();
    ctx.strokeStyle = inkColor();
    dirty = strokes.length > 0;
    updateHint();
  }

  function cloneStroke(stroke) {
    return { width: stroke.width, fast: !!stroke.fast, pts: stroke.pts.map(function (p) { return { x: p.x, y: p.y }; }) };
  }

  function cloneStrokes(list) { return list.map(cloneStroke); }

  function selectionBounds(list) {
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var i = 0; i < list.length; i += 1) {
      for (var j = 0; j < list[i].pts.length; j += 1) {
        var p = list[i].pts[j];
        minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
      }
    }
    return isFinite(minX) ? { minX: minX, minY: minY, maxX: maxX, maxY: maxY } : null;
  }

  function drawSelectionOverlay() {
    ctx.save();
    ctx.setLineDash ? ctx.setLineDash([7 / view.scale, 5 / view.scale]) : null;
    ctx.lineWidth = 1.5 / view.scale;
    ctx.strokeStyle = darkMode ? "#fff" : "#111";
    if (lassoPoints.length > 1) {
      ctx.beginPath(); ctx.moveTo(lassoPoints[0].x, lassoPoints[0].y);
      for (var i = 1; i < lassoPoints.length; i += 1) ctx.lineTo(lassoPoints[i].x, lassoPoints[i].y);
      ctx.stroke();
    }
    var b = selectionBounds(selectedStrokes);
    if (b) ctx.strokeRect(b.minX - 8, b.minY - 8, b.maxX - b.minX + 16, b.maxY - b.minY + 16);
    ctx.restore();
  }

  function pointInPolygon(point, polygon) {
    var inside = false;
    for (var i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      var a = polygon[i], b = polygon[j];
      if (((a.y > point.y) !== (b.y > point.y)) &&
          point.x < (b.x - a.x) * (point.y - a.y) / ((b.y - a.y) || 0.00001) + a.x) inside = !inside;
    }
    return inside;
  }

  function selectWithLasso() {
    selectedStrokes = [];
    if (lassoPoints.length > 2) {
      for (var i = 0; i < strokes.length; i += 1) {
        for (var j = 0; j < strokes[i].pts.length; j += 1) {
          if (pointInPolygon(strokes[i].pts[j], lassoPoints)) { selectedStrokes.push(strokes[i]); break; }
        }
      }
    }
    lassoPoints = [];
    syncSelectionButtons();
    redrawStrokes();
    setStatus(selectedStrokes.length ? selectedStrokes.length + " stroke(s) selected" : "Nothing selected");
  }

  function pointInSelection(point) {
    var b = selectionBounds(selectedStrokes);
    return !!b && point.x >= b.minX - 14 && point.x <= b.maxX + 14 && point.y >= b.minY - 14 && point.y <= b.maxY + 14;
  }

  function syncSelectionButtons() {
    if (copyBtn) copyBtn.disabled = !selectedStrokes.length;
    if (rotateSelectionBtn) rotateSelectionBtn.disabled = !selectedStrokes.length;
    if (pasteBtn) pasteBtn.disabled = !selectionClipboard.length;
  }

  function snapshotChange() { historyActions.push({ type: "change", before: cloneStrokes(strokes) }); }

  function copySelection() {
    if (!selectedStrokes.length) return;
    selectionClipboard = cloneStrokes(selectedStrokes);
    syncSelectionButtons();
    setStatus("Selection copied");
  }

  function pasteSelection() {
    if (!selectionClipboard.length) return;
    snapshotChange();
    selectedStrokes = cloneStrokes(selectionClipboard);
    for (var i = 0; i < selectedStrokes.length; i += 1) {
      for (var j = 0; j < selectedStrokes[i].pts.length; j += 1) {
        selectedStrokes[i].pts[j].x += 24; selectedStrokes[i].pts[j].y += 24;
      }
      strokes.push(selectedStrokes[i]);
    }
    dirty = true; syncSelectionButtons(); redrawStrokes(); setStatus("Selection pasted - drag to place");
  }

  function rotateSelection() {
    var b = selectionBounds(selectedStrokes); if (!b) return;
    snapshotChange();
    var cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
    for (var i = 0; i < selectedStrokes.length; i += 1) {
      for (var j = 0; j < selectedStrokes[i].pts.length; j += 1) {
        var p = selectedStrokes[i].pts[j], dx = p.x - cx, dy = p.y - cy;
        p.x = cx - dy; p.y = cy + dx;
      }
    }
    redrawStrokes(); setStatus("Selection rotated 90 degrees");
  }

  function undoStroke() {
    if (drawing || erasing || !historyActions.length) return;
    var action = historyActions.pop();
    if (action.type === "draw") {
      var drawIndex = strokes.indexOf(action.stroke);
      if (drawIndex !== -1) strokes.splice(drawIndex, 1);
    } else if (action.type === "erase") {
      action.removed.sort(function (a, b) { return b.index - a.index; });
      for (var r = 0; r < action.removed.length; r += 1) {
        strokes.splice(action.removed[r].index, 0, action.removed[r].stroke);
      }
    } else if (action.type === "change") {
      strokes = cloneStrokes(action.before);
      selectedStrokes = [];
      syncSelectionButtons();
    }
    redrawStrokes();
    setStatus(strokes.length ? "Undo" : "Page blank");
  }

  function pointSegmentDistanceSquared(p, a, b) {
    var dx = b.x - a.x;
    var dy = b.y - a.y;
    if (!dx && !dy) {
      dx = p.x - a.x;
      dy = p.y - a.y;
      return dx * dx + dy * dy;
    }
    var t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy);
    t = Math.max(0, Math.min(1, t));
    var x = a.x + t * dx;
    var y = a.y + t * dy;
    dx = p.x - x;
    dy = p.y - y;
    return dx * dx + dy * dy;
  }

  function strokeTouchesEraser(stroke, point) {
    var radius = 15 / view.scale + stroke.width / 2;
    var limit = radius * radius;
    if (stroke.pts.length === 1) return pointSegmentDistanceSquared(point, stroke.pts[0], stroke.pts[0]) <= limit;
    for (var i = 1; i < stroke.pts.length; i += 1) {
      if (pointSegmentDistanceSquared(point, stroke.pts[i - 1], stroke.pts[i]) <= limit) return true;
    }
    return false;
  }

  function eraseAt(point) {
    var changed = false;
    for (var i = strokes.length - 1; i >= 0; i -= 1) {
      if (!strokeTouchesEraser(strokes[i], point)) continue;
      if (!currentEraseAction) {
        currentEraseAction = { type: "erase", removed: [] };
        historyActions.push(currentEraseAction);
      }
      currentEraseAction.removed.push({ index: i, stroke: strokes[i] });
      strokes.splice(i, 1);
      changed = true;
    }
    if (changed) redrawStrokes();
  }

  function formReply(text) {
    setReplyCollapsed(false);
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

  function setReplyCollapsed(collapsed) {
    if (!document.body) return;
    if (collapsed) document.body.classList.add("replyCollapsed");
    else document.body.classList.remove("replyCollapsed");
    if (replyToggle) replyToggle.textContent = collapsed ? "Show" : "Hide";
  }

  function toggleReply() {
    setReplyCollapsed(!document.body.classList.contains("replyCollapsed"));
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
    if (/unauthorized|HTTP 401/i.test(String(message || ""))) {
      out.innerHTML = "<p><strong>Diary authorization expired.</strong></p>" +
        "<p>Reopen the secure Kindle bookmark once. Your writing is still here.</p>";
    } else {
      out.innerHTML = "<p><strong>Couldn't reach Hermes.</strong></p><p>" +
        escapeHtml(message) + "</p><p>Your writing is still there — tap Send to try again.</p>";
    }
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
    var control = t;
    while (control && control !== wrap) {
      if (/^(BUTTON|INPUT|LABEL|SUMMARY|SELECT|TEXTAREA)$/.test(control.tagName || "")) return true;
      control = control.parentNode;
    }
    if (event.pointerId !== undefined && wrap.setPointerCapture) {
      try { wrap.setPointerCapture(event.pointerId); } catch (err) {}
    }
    rectCache = canvas.getBoundingClientRect();

    // Pan mode: drag moves the page instead of drawing on it.
    if (panMode) {
      panning = true;
      panStartScreen = canvasPointFromEvent(event);
      panStartOffset = { ox: view.ox, oy: view.oy };
      return stopEvent(event);
    }

    if (lassoMode) {
      var selectionPoint = pointFromEvent(event);
      if (selectedStrokes.length && pointInSelection(selectionPoint)) {
        snapshotChange();
        movingSelection = true;
        selectionDragStart = selectionPoint;
        selectionDragOriginal = selectedStrokes.map(function (stroke) {
          return { stroke: stroke, pts: stroke.pts.map(function (p) { return { x: p.x, y: p.y }; }) };
        });
      } else {
        selectedStrokes = [];
        lassoing = true;
        lassoPoints = [selectionPoint];
      }
      syncSelectionButtons(); redrawStrokes();
      return stopEvent(event);
    }

    if (eraserMode) {
      erasing = true;
      currentEraseAction = null;
      eraseAt(pointFromEvent(event));
      return stopEvent(event);
    }

    warm(); // pen touched paper — start waking the model now
    // Riddle behavior: pen touching the page makes the old words vanish.
    if (pageText.innerHTML) {
      revealGen += 1;
      pageText.innerHTML = "";
      pageText.style.color = "";
    }
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
    historyActions.push({ type: "draw", stroke: currentStroke });
    drawing = true;
    dirty = true;
    showHint(false);
    return stopEvent(event);
  }

  function move(event) {
    if (panning) {
      var c = canvasPointFromEvent(event);
      // Move the world opposite to the drag so content follows the finger.
      view.ox = panStartOffset.ox - (c.x - panStartScreen.x) / view.scale;
      view.oy = panStartOffset.oy - (c.y - panStartScreen.y) / view.scale;
      applyView();
      redrawStrokes();
      return stopEvent(event);
    }
    if (movingSelection) {
      var mp = pointFromEvent(event), dx = mp.x - selectionDragStart.x, dy = mp.y - selectionDragStart.y;
      for (var m = 0; m < selectionDragOriginal.length; m += 1) {
        var original = selectionDragOriginal[m];
        for (var n = 0; n < original.pts.length; n += 1) {
          original.stroke.pts[n].x = original.pts[n].x + dx;
          original.stroke.pts[n].y = original.pts[n].y + dy;
        }
      }
      redrawStrokes(); return stopEvent(event);
    }
    if (lassoing) {
      var lp = pointFromEvent(event);
      var prior = lassoPoints[lassoPoints.length - 1];
      if (!prior || Math.abs(lp.x - prior.x) + Math.abs(lp.y - prior.y) > 3 / view.scale) lassoPoints.push(lp);
      redrawStrokes(); return stopEvent(event);
    }
    if (erasing) {
      eraseAt(pointFromEvent(event));
      return stopEvent(event);
    }
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
    if (panning) {
      panning = false;
      panStartScreen = null;
      return stopEvent(event);
    }
    if (movingSelection) {
      movingSelection = false; selectionDragStart = null; selectionDragOriginal = null;
      dirty = true; redrawStrokes(); setStatus("Selection moved"); return stopEvent(event);
    }
    if (lassoing) {
      lassoing = false; selectWithLasso(); return stopEvent(event);
    }
    if (erasing) {
      erasing = false;
      currentEraseAction = null;
      setStatus("Eraser mode");
      return stopEvent(event);
    }
    if (!drawing) return stopEvent(event);
    flushQueue();
    // Quadratic smoothing ends at the midpoint of the final pair. Complete
    // the short tail on pen-up so letters do not look clipped.
    if (strokeDrew && currentStroke && !currentStroke.fast && last && pathEnd) {
      ctx.beginPath();
      ctx.moveTo(pathEnd.x, pathEnd.y);
      ctx.lineTo(last.x, last.y);
      ctx.stroke();
    }
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
    resetView();
    strokes = [];
    historyActions = [];
    currentStroke = null;
    selectedStrokes = [];
    lassoPoints = [];
    syncSelectionButtons();
    dirty = false;
    clearScreen();
    updateHint();
    setStatus("Ready");
  }

  function escHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  // Whitelist-sanitize model-emitted HTML/SVG so an artifact can render safely.
  var SANITIZE_ALLOWED = {
    P: 1, BR: 1, HR: 1, B: 1, STRONG: 1, I: 1, EM: 1, U: 1, S: 1, SPAN: 1, DIV: 1,
    H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1, UL: 1, OL: 1, LI: 1, TABLE: 1,
    THEAD: 1, TBODY: 1, TR: 1, TH: 1, TD: 1, BLOCKQUOTE: 1, PRE: 1, CODE: 1,
    A: 1, IMG: 1, SMALL: 1, SUB: 1, SUP: 1, FIGURE: 1, FIGCAPTION: 1, LABEL: 1,
    SVG: 1, PATH: 1, RECT: 1, CIRCLE: 1, LINE: 1, G: 1, TEXT: 1, TSPAN: 1,
    POLYLINE: 1, POLYGON: 1, ELLIPSE: 1, DEFS: 1, TITLE: 1, MARKER: 1
  };

  function sanitizeHtml(html) {
    // Pre-scrub the raw string so no img-onerror etc. fires before DOM cleanup.
    var pre = String(html || "")
      .replace(/<\s*(script|style|iframe|object|embed|link|meta|base)[\s\S]*?<\/\s*\1\s*>/gi, "")
      .replace(/<\s*(script|style|iframe|object|embed|link|meta|base)[^>]*>/gi, "")
      .replace(/\son\w+\s*=\s*"[^"]*"/gi, "")
      .replace(/\son\w+\s*=\s*'[^']*'/gi, "")
      .replace(/\son\w+\s*=\s*[^\s>]+/gi, "");
    var container = document.createElement("div");
    try {
      container.innerHTML = pre;
    } catch (e) {
      return escHtml(html);
    }
    walkSanitize(container);
    return container.innerHTML;
  }

  function walkSanitize(node) {
    var child = node.firstChild;
    while (child) {
      var next = child.nextSibling;
      if (child.nodeType === 1) {
        var tag = (child.tagName || "").toUpperCase();
        if (!SANITIZE_ALLOWED[tag]) {
          if (tag === "SCRIPT" || tag === "STYLE") {
            node.removeChild(child);
          } else {
            while (child.firstChild) node.insertBefore(child.firstChild, child);
            node.removeChild(child);
          }
        } else {
          scrubAttrs(child);
          walkSanitize(child);
        }
      }
      child = next;
    }
  }

  function scrubAttrs(el) {
    var attrs = el.attributes;
    for (var i = attrs.length - 1; i >= 0; i -= 1) {
      var name = (attrs[i].name || "").toLowerCase();
      var val = attrs[i].value || "";
      if (name.indexOf("on") === 0) {
        el.removeAttribute(attrs[i].name);
        continue;
      }
      if (name === "href" || name === "src" || name === "xlink:href") {
        var v = val.replace(/\s/g, "").toLowerCase();
        if (v.indexOf("javascript:") === 0 || v.indexOf("vbscript:") === 0 ||
            (v.indexOf("data:") === 0 && v.indexOf("data:image/") !== 0)) {
          el.removeAttribute(attrs[i].name);
        }
      }
    }
  }

  // Inline formatting on an already-escaped string: code, bold, italic, links.
  function inlineMd(s) {
    var codes = [];
    s = s.replace(/`([^`]+)`/g, function (m, c) {
      codes.push(c);
      return "\u0000" + (codes.length - 1) + "\u0000";
    });
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
    s = s.replace(/(^|[^_])_([^_]+)_/g, "$1<em>$2</em>");
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (m, t, u) {
      if (/^(javascript|vbscript|data):/i.test(u)) return t;
      return '<a href="' + u + '">' + t + "</a>";
    });
    s = s.replace(/\u0000(\d+)\u0000/g, function (m, n) {
      return "<code>" + codes[Number(n)] + "</code>";
    });
    return s;
  }

  function markdownLite(text) {
    var lines = String(text || "").split(/\r?\n/);
    var out = "";
    var i = 0;
    function isTableSep(l) { return /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(l) && l.indexOf("|") >= 0; }
    function cells(l) {
      var t = l.replace(/^\s*\|/, "").replace(/\|\s*$/, "");
      return t.split("|");
    }
    while (i < lines.length) {
      var line = lines[i];
      var fence = line.match(/^```(\w*)\s*$/);
      if (fence) {
        var lang = (fence[1] || "").toLowerCase();
        var buf = [];
        i += 1;
        while (i < lines.length && !/^```\s*$/.test(lines[i])) { buf.push(lines[i]); i += 1; }
        i += 1;
        var body = buf.join("\n");
        if (lang === "html" || lang === "svg") {
          out += '<div class="artifact">' + sanitizeHtml(body) + "</div>";
        } else {
          out += "<pre><code>" + escHtml(body) + "</code></pre>";
        }
        continue;
      }
      // Raw artifact block: a line that is a full <svg...>...</svg> or fenced by <artifact>
      if (/^\s*<(svg|table|figure)[\s>]/i.test(line)) {
        var block = [line];
        i += 1;
        var closer = line.match(/<\s*(svg|table|figure)/i)[1];
        while (i < lines.length && line.toLowerCase().indexOf("</" + closer.toLowerCase() + ">") < 0) {
          line = lines[i]; block.push(line); i += 1;
        }
        out += '<div class="artifact">' + sanitizeHtml(block.join("\n")) + "</div>";
        continue;
      }
      if (isTableSep(lines[i + 1] || "") && line.indexOf("|") >= 0) {
        var head = cells(line);
        i += 2;
        var rowsHtml = "";
        while (i < lines.length && lines[i].indexOf("|") >= 0 && lines[i].trim() !== "") {
          var rc = cells(lines[i]);
          rowsHtml += "<tr>";
          for (var c = 0; c < rc.length; c += 1) rowsHtml += "<td>" + inlineMd(escHtml(rc[c].trim())) + "</td>";
          rowsHtml += "</tr>";
          i += 1;
        }
        var headHtml = "<tr>";
        for (var h = 0; h < head.length; h += 1) headHtml += "<th>" + inlineMd(escHtml(head[h].trim())) + "</th>";
        headHtml += "</tr>";
        out += "<table><thead>" + headHtml + "</thead><tbody>" + rowsHtml + "</tbody></table>";
        continue;
      }
      var hd = line.match(/^(#{1,4})\s+(.+)/);
      if (hd) {
        var lvl = hd[1].length;
        out += "<h" + lvl + ">" + inlineMd(escHtml(hd[2])) + "</h" + lvl + ">";
        i += 1;
        continue;
      }
      if (/^\s*([-*_])\1\1+\s*$/.test(line)) { out += "<hr>"; i += 1; continue; }
      if (/^\s*>\s?/.test(line)) {
        var q = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) { q.push(escHtml(lines[i].replace(/^\s*>\s?/, ""))); i += 1; }
        out += "<blockquote>" + inlineMd(q.join("<br>")) + "</blockquote>";
        continue;
      }
      if (/^\s*[-*]\s+/.test(line)) {
        out += "<ul>";
        while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
          out += "<li>" + inlineMd(escHtml(lines[i].replace(/^\s*[-*]\s+/, ""))) + "</li>";
          i += 1;
        }
        out += "</ul>";
        continue;
      }
      if (/^\s*\d+\.\s+/.test(line)) {
        out += "<ol>";
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
          out += "<li>" + inlineMd(escHtml(lines[i].replace(/^\s*\d+\.\s+/, ""))) + "</li>";
          i += 1;
        }
        out += "</ol>";
        continue;
      }
      if (line.replace(/\s/g, "") === "") { i += 1; continue; }
      var para = [];
      while (i < lines.length && lines[i].trim() !== "" &&
             !/^```/.test(lines[i]) && !/^\s*[-*]\s+/.test(lines[i]) &&
             !/^\s*\d+\.\s+/.test(lines[i]) && !/^(#{1,4})\s+/.test(lines[i]) &&
             !/^\s*>\s?/.test(lines[i]) && !(isTableSep(lines[i + 1] || "") && lines[i].indexOf("|") >= 0)) {
        para.push(escHtml(lines[i]));
        i += 1;
      }
      out += "<p>" + inlineMd(para.join("<br>")) + "</p>";
    }
    return out || "<p>No response text.</p>";
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
    if (!thread.length) {
      sessionLabel.innerHTML = "New entry";
    } else {
      var label = "Entry: " + escapeHtml(sessionTitle || "Untitled");
      // Nudge toward a fresh entry once a thread gets long, so unrelated
      // topics don't keep piling into (and polluting) one conversation.
      if (thread.length >= LONG_THREAD) {
        label += ' &middot; <span class="nudge">long — tap New for a fresh topic</span>';
      }
      sessionLabel.innerHTML = label;
    }
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
        if (m.ink) html += '<img class="inkThumb" src="' + secureMediaUrl(m.ink) + '" alt="handwritten entry">';
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
      setAuth(xhr);
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
      setAuth(x);
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

  function finishNewEntry(channelThreadId, resetWorked) {
    sessionId = null;
    hermesThreadId = channelThreadId || newHermesThreadId();
    sessionTitle = "";
    thread = [];
    storageSet("diarySessionId", null);
    clearInk();
    typed.value = "";
    renderLatest();
    hideHistory();
    setBusy(false);
    setStatus(resetWorked ? "New Hermes session" : "New session (fresh channel)");
  }

  function newEntry() {
    var previousThreadId = hermesThreadId;
    if (!sessionId || !previousThreadId) {
      finishNewEntry(newHermesThreadId(), true);
      return;
    }
    setBusy(true);
    setStatus("Starting new Hermes session");
    ajaxJson("POST", "/api/channel/reset", { chatId: previousThreadId }, function (error, json) {
      // A successful /new rotates Hermes's durable session while preserving
      // this channel lane. On failure, use a brand-new lane so context cannot
      // leak even though the old route could not be finalized.
      var resetWorked = !error && json && json.ok;
      finishNewEntry(resetWorked ? previousThreadId : newHermesThreadId(), resetWorked);
    }, 45000);
  }

  function syncBodyClass() {
    var cls = ["split"];
    if (landscape) cls.push("landscape");
    if (darkMode) cls.push("dark");
    document.body.className = cls.join(" ");
  }

  function applyDark(on) {
    darkMode = !!on;
    storageSet("diaryDark", darkMode ? "1" : null);
    syncBodyClass();
    if (strokes.length) redrawStrokes(); // recolor existing ink for the theme
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
    hermesThreadId = viewedSession.channelThreadId || viewedSession.id;
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
      // Session hygiene: don't silently resume a stale entry. If the last
      // activity was hours ago, start fresh so a new topic doesn't pile onto
      // an old one (which is how everything ended up in one long thread).
      var updated = s.updatedAt ? Date.parse(s.updatedAt) : 0;
      if (updated && ((new Date()).getTime() - updated) > STALE_SESSION_MS) {
        storageSet("diarySessionId", null);
        renderLatest();
        setStatus("Started a fresh entry");
        return;
      }
      sessionId = s.id;
      hermesThreadId = s.channelThreadId || s.id;
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
        hermesThreadId = newHermesThreadId();
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
      sessionId: sessionId,
      hermesThreadId: hermesThreadId
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
    resetView();
    ctx.strokeStyle = inkColor();
    strokes = [];
    historyActions = [];
    currentStroke = null;
    dirty = false;
    clearScreen();
    updateHint();
  }

  function sendInner() {
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
    var ready = true;

    function restoreInk() {
      strokes = savedStrokes;
      redrawStrokes();
    }

    function clearCanvas() {
      resetView();
      ctx.strokeStyle = inkColor();
      strokes = [];
      historyActions = [];
      currentStroke = null;
      dirty = false;
      clearScreen();
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
      clearCanvas();
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

    // Keep the writing visible while the reply pane shows progress.
    startThinking();

    ajaxJson("POST", "/api/send", payload, function (error, json) {
      if (error || !json.ok) {
        failed = (error && error.message) || json.error || "Send failed";
        proceed();
        return;
      }
      sessionId = json.sessionId;
      hermesThreadId = json.hermesThreadId || hermesThreadId;
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
    var gen = ++revealGen;               // cancels any prior reveal/stream
    var revealReady = true;
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
          if (meta && meta.hermesThreadId) hermesThreadId = meta.hermesThreadId;
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
      clearCanvasNow();
      paint(true);
      setBusy(false);
      setStatus("Reply from Hermes");
    }

    var xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/send", true);
    xhr.setRequestHeader("content-type", "application/json");
      setAuth(xhr);
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

    startThinking();

    try {
      xhr.send(JSON.stringify(payload));
    } catch (err) {
      errMsg = (err && err.message) || "Could not send";
      finishStream();
    }
  }

  function add(el, name, fn) {
    if (!el) return;
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
  add(pgUp, "click", function () { pageScroll(-1); });
  add(pgDn, "click", function () { pageScroll(1); });
  add(pgUp2, "click", function () { pageScroll(-1); });
  add(pgDn2, "click", function () { pageScroll(1); });
  add(replyToggle, "click", toggleReply);
  add(zoomInBtn, "click", zoomIn);
  add(zoomOutBtn, "click", zoomOut);
  add(panBtn, "click", togglePan);
  add(resetViewBtn, "click", resetViewAndRedraw);
  add(eraserBtn, "click", toggleEraser);
  add(lassoBtn, "click", toggleLasso);
  add(copyBtn, "click", copySelection);
  add(pasteBtn, "click", pasteSelection);
  add(rotateSelectionBtn, "click", rotateSelection);

  var savedStrokeWidth = storageGet("diaryStrokeWidth");
  if (savedStrokeWidth && strokeWidthEl) strokeWidthEl.value = savedStrokeWidth;
  if (strokeWidthValueEl && strokeWidthEl) strokeWidthValueEl.value = strokeWidthEl.value;
  add(strokeWidthEl, "input", function () {
    if (strokeWidthValueEl) strokeWidthValueEl.value = strokeWidthEl.value;
    storageSet("diaryStrokeWidth", strokeWidthEl.value);
  });
  if (fastInkEl) {
    fastInkEl.checked = storageGet("diaryFastInk") === "1";
    add(fastInkEl, "change", function () {
      storageSet("diaryFastInk", fastInkEl.checked ? "1" : "0");
      setStatus(fastInkEl.checked ? "Fast ink" : "Smooth ink");
    });
  }

  // The diary is a Hermes client first. Remember an explicit alternate target,
  // but default new devices to the secured, tool-capable firm-agent channel.
  var savedTarget = storageGet("diaryTarget");
  targetEl.value = savedTarget || "hermes";
  add(targetEl, "change", function () {
    storageSet("diaryTarget", targetEl.value);
    setStatus(targetEl.value === "hermes" ? "Firm tools ready" : "Target changed");
  });

  // Riddle mode was retired; clear any saved preference from older versions.
  storageSet("diaryMode", null);
  landscape = storageGet("diaryLandscape") === "1";
  darkMode = storageGet("diaryDark") === "1";
  if (streamEl) {
    streamEl.checked = storageGet("diaryStream") !== "0";
    add(streamEl, "change", function () {
      storageSet("diaryStream", streamEl.checked ? "1" : "0");
    });
  }
  var darkEl = document.getElementById("darkOn");
  if (darkEl) {
    darkEl.checked = darkMode;
    add(darkEl, "change", function () { applyDark(darkEl.checked); });
  }
  syncBodyClass();
  syncSelectionButtons();

  resizeCanvas();
  showHint(true);
  setStatus("Ready");
  loadConfig();
  warm(); // wake the model on open
  hideHistory();

  var savedSession = storageGet("diarySessionId");
  if (savedSession) activateSession(savedSession);
  else {
    hermesThreadId = newHermesThreadId();
    renderLatest();
  }
}());
