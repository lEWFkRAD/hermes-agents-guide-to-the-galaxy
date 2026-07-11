(function () {
  var authTok = "";
  var remoteKey = "";
  var revision = "";
  var loading = false;
  var pollTimer = null;
  var pendingPage = null;
  var darkMode = false;
  var sessionId = "";
  var hermesThreadId = "";
  var sendBusy = false;
  var progressTimer = null;
  var progressIndex = 0;

  (function readAccessAndTheme() {
    var search = window.location.search || "";
    var authMatch = search.match(/[?&]k=([^&#]+)/);
    var remoteQuery = search.match(/[?&]rk=([^&#]+)/);
    var remotePath = (window.location.pathname || "").match(/^\/remote\/([^/]+)(?:\/live)?\/?$/);
    if (remoteQuery) remoteKey = decodeURIComponent(remoteQuery[1]);
    else if (remotePath) remoteKey = decodeURIComponent(remotePath[1]);
    try {
      if (authMatch) {
        authTok = decodeURIComponent(authMatch[1]);
        window.localStorage.setItem("diaryAuth", authTok);
      } else {
        authTok = window.localStorage.getItem("diaryAuth") || "";
      }
      darkMode = /(?:^|[?&])theme=dark(?:&|$)/.test(search) || window.localStorage.getItem("diaryDark") === "1";
      sessionId = window.localStorage.getItem("diarySessionId") || "";
      hermesThreadId = window.localStorage.getItem("diaryHermesThreadId") || "";
    } catch (error) {
      darkMode = /(?:^|[?&])theme=dark(?:&|$)/.test(search);
    }
    document.documentElement.className = darkMode ? "dark" : "";
  }());

  function add(element, name, handler) {
    if (!element) return;
    if (element.addEventListener) element.addEventListener(name, handler, false);
    else if (element.attachEvent) element.attachEvent("on" + name, handler);
  }

  function setAuth(xhr) {
    if (authTok) {
      try { xhr.setRequestHeader("x-diary-auth", authTok); } catch (error) {}
    }
    if (remoteKey) {
      try { xhr.setRequestHeader("x-diary-remote-key", remoteKey); } catch (error) {}
    }
  }

  function setText(element, value) {
    if (!element) return;
    var text = value == null ? "" : String(value);
    if (typeof element.textContent !== "undefined") element.textContent = text;
    else element.innerText = text;
  }

  function stopEvent(event) {
    if (event.preventDefault) event.preventDefault();
    if (event.stopPropagation) event.stopPropagation();
    event.returnValue = false;
    return false;
  }

  var stateEl = document.getElementById("liveState");
  var messageEl = document.getElementById("liveMessage");
  var surfaceEl = document.getElementById("livingSurface");
  var frameEl = document.getElementById("liveFrame");
  var canvasEl = document.getElementById("liveInk");
  var displayEl = document.getElementById("liveInkDisplay");
  var drawModeBtn = document.getElementById("drawModeBtn");
  var undoInkBtn = document.getElementById("undoInkBtn");
  var sendInkBtn = document.getElementById("sendInkBtn");
  var intentBtns = document.getElementsByClassName ? document.getElementsByClassName("intentBtn") : [];
  var clearInkBtn = document.getElementById("clearInkBtn");
  var eraserInkBtn = document.getElementById("eraserInkBtn");
  var copyInkBtn = document.getElementById("copyInkBtn");
  var pasteInkBtn = document.getElementById("pasteInkBtn");
  var lassoInkBtn = document.getElementById("lassoInkBtn");
  var rotateInkBtn = document.getElementById("rotateInkBtn");
  var deleteSelectionBtn = document.getElementById("deleteSelectionBtn");
  var moveSelectionBtn = document.getElementById("moveSelectionBtn");
  var askSelectionBtn = document.getElementById("askSelectionBtn");
  var backBtn = document.getElementById("backBtn");
  var liveHistoryBtn = document.getElementById("liveHistoryBtn");
  var liveNewBtn = document.getElementById("liveNewBtn");
  var liveThemeBtn = document.getElementById("liveThemeBtn");
  var hermesToggleBtn = document.getElementById("hermesToggleBtn");
  var moreToggleBtn = document.getElementById("moreToggleBtn");
  var hermesToolsEl = document.getElementById("hermesTools");
  var moreToolsEl = document.getElementById("moreTools");
  var emptyHintEl = document.getElementById("emptyHint");
  var liveSendBtn = document.getElementById("liveSendBtn");
  var liveHistoryEl = document.getElementById("liveHistory");
  var liveHistoryCloseBtn = document.getElementById("liveHistoryCloseBtn");
  var liveHistoryList = document.getElementById("liveHistoryList");
  var annotationToggleBtn = document.getElementById("annotationToggleBtn");
  var annotationToolsEl = document.getElementById("annotationTools");
  if (!surfaceEl || !frameEl || !canvasEl || !displayEl) return;
  var replyEl = document.getElementById("liveReply");
  var replyTextEl = document.getElementById("liveReplyText");
  var replyKindEl = document.getElementById("liveReplyKind");
  var closeReplyBtn = document.getElementById("closeReplyBtn");

  var strokes = [];
  var currentStroke = null;
  var drawing = false;
  var drawMode = true;
  var toolsOpen = false;
  var eraserMode = false;
  var inkClipboard = [];
  var lassoMode = false;
  var lassoing = false;
  var lassoPoints = [];
  var selectedStrokeIds = [];
  var clearArmed = false, clearTimer = null;
  var moveMode=false,movingSelection=false,moveStart=null,moveOriginals=[];
  var movePreviewFrame=null,movePreviewPoint=null;
  var streamPaintTimer=null,lastStreamPaint="";
  var newPageBusy=false;
  var INK_STORAGE_KEY = "livePageInkV1";
  var INK_CLIENT_KEY = "livePageInkClientV2";
  var INK_MIGRATION_KEY = "livePageInkMigratedV2";
  var INK_SEND_KEY = "livePageInkPendingSendV1";
  var INK_OP_PREFIX = "livePageInkOpV2:";
  var INK_REJECTED_PREFIX = "livePageInkRejectedV2:";
  var deviceId = "";
  var inkIdSequence = 0;
  var inkSyncRevision = "";
  var inkActiveRevision = "";
  var inkSyncLoading = false;
  var inkSyncPosting = false;
  var inkSyncReady = false;
  var inkPollTimer = null;
  var inkSyncBackoff = 5000;
  var pendingInkSnapshot = null;
  var serverInkStrokes = [];
  var startupInkStrokes = [];
  var startupInkRecovered = false;
  var volatileInkOperations = [];
  var inkBatchLimit = 50;
  var currentDisplayEl = null;
  var MAX_POINT_T = 600000;
  var pendingInkSend = null;
  var emptyHintDismissed = !!sessionId;

  function inkColor() {
    return darkMode ? "#f2efe7" : "#171612";
  }

  function unsentStrokes() {
    var pending = [];
    for (var i = 0; i < strokes.length; i += 1) if (!strokes[i].sent) pending.push(strokes[i]);
    return pending;
  }

  function validSyncId(value) {
    return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(String(value || ""));
  }

  function storageGet(key) {
    try { return window.localStorage.getItem(key); } catch (error) { return null; }
  }

  function storageSet(key, value) {
    try {
      window.localStorage.setItem(key, value);
      return true;
    } catch (error) {
      setText(stateEl, "Ink is offline");
      return false;
    }
  }

  function storageRemove(key) {
    try { window.localStorage.removeItem(key); } catch (error) {}
  }

  function normalizePendingInkSend(value) {
    if (!value || typeof value !== "object" || !validSyncId(value.id)) return null;
    var source = Object.prototype.toString.call(value.strokeIds) === "[object Array]" ? value.strokeIds : [];
    var ids = [];
    for (var i = 0; i < source.length && ids.length < 500; i += 1) {
      var id = String(source[i] || "");
      if (!validSyncId(id)) return null;
      var duplicate = false;
      for (var j = 0; j < ids.length; j += 1) if (ids[j] === id) duplicate = true;
      if (!duplicate) ids.push(id);
    }
    if (!ids.length) return null;
    return { id: String(value.id), strokeIds: ids };
  }

  function readPendingInkSend() {
    var value = null;
    try { value = JSON.parse(storageGet(INK_SEND_KEY) || "null"); } catch (error) {}
    value = normalizePendingInkSend(value);
    if (!value) storageRemove(INK_SEND_KEY);
    return value;
  }

  function keepPendingInkSend(value) {
    pendingInkSend = normalizePendingInkSend(value);
    if (pendingInkSend) storageSet(INK_SEND_KEY, JSON.stringify(pendingInkSend));
    updateInkButtons();
  }

  function clearPendingInkSend(sendId) {
    if (sendId && pendingInkSend && pendingInkSend.id !== sendId) return;
    pendingInkSend = null;
    storageRemove(INK_SEND_KEY);
    updateInkButtons();
  }

  function pendingInkSendHasId(id) {
    if (!pendingInkSend) return false;
    for (var i = 0; i < pendingInkSend.strokeIds.length; i += 1) {
      if (pendingInkSend.strokeIds[i] === id) return true;
    }
    return false;
  }

  function copyValue(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function ensureDeviceId() {
    var saved = storageGet(INK_CLIENT_KEY) || "";
    if (validSyncId(saved)) return saved;
    saved = "device-" + (new Date()).getTime().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
    storageSet(INK_CLIENT_KEY, saved);
    return saved;
  }

  function nextInkId(prefix) {
    inkIdSequence += 1;
    return prefix + "-" + deviceId + "-" + (new Date()).getTime().toString(36) + "-" + inkIdSequence.toString(36) + "-" + Math.random().toString(36).slice(2, 7);
  }

  function normalizeLocalAnchor(raw) {
    if (!raw || typeof raw !== "object") return null;
    var selector = String(raw.selector || "").replace(/[\u0000-\u001f]/g, "").slice(0, 400);
    if (!selector) return null;
    var rect = raw.rect && typeof raw.rect === "object" ? raw.rect : {};
    function unit(value) {
      var number = Number(value);
      return isFinite(number) ? Math.max(0, Math.min(1, number)) : 0;
    }
    return {
      selector: selector,
      tag: String(raw.tag || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32).toLowerCase(),
      text: String(raw.text || "").replace(/\s+/g, " ").trim().slice(0, 240),
      rect: { x: unit(rect.x), y: unit(rect.y), width: unit(rect.width), height: unit(rect.height) },
      hitCount: Math.max(1, Math.min(1000, Math.round(Number(raw.hitCount) || 1))),
      centered: !!raw.centered
    };
  }

  function normalizeLocalStroke(raw, fallbackIndex) {
    if (!raw || typeof raw !== "object") return null;
    var sourcePoints = Object.prototype.toString.call(raw.points) === "[object Array]" ? raw.points : [];
    var points = [];
    for (var i = 0; i < sourcePoints.length && points.length < 1200; i += 1) {
      var x = Number(sourcePoints[i] && sourcePoints[i].x);
      var y = Number(sourcePoints[i] && sourcePoints[i].y);
      if (isFinite(x) && isFinite(y) && x >= 0 && x <= 1 && y >= 0 && y <= 1) {
        var point = { x: x, y: y };
        var pointTime = Number(sourcePoints[i] && sourcePoints[i].t);
        if (isFinite(pointTime) && pointTime >= 0 && pointTime <= MAX_POINT_T) point.t = Math.round(pointTime);
        points.push(point);
      }
    }
    if (!points.length) return null;
    var id = validSyncId(raw.id) ? String(raw.id) : "legacy-" + deviceId + "-" + String(fallbackIndex);
    var strokeClientId = validSyncId(raw.clientId) ? String(raw.clientId) : deviceId;
    var baseRevision = /^sha256:[a-f0-9]{64}$/.test(String(raw.baseRevision || raw.pageRevision || "")) ? String(raw.baseRevision || raw.pageRevision) : "";
    var createdAt = Number(raw.createdAt);
    if (!isFinite(createdAt) || createdAt < 0) createdAt = Number(fallbackIndex) || 0;
    var surfaceWidth = Number(raw.surfaceWidth);
    var surfaceHeight = Number(raw.surfaceHeight);
    var order = Number(raw.order);
    var sourceAnchors = Object.prototype.toString.call(raw.anchors) === "[object Array]" ? raw.anchors : [];
    var anchors = [];
    for (var anchorIndex = 0; anchorIndex < sourceAnchors.length && anchors.length < 6; anchorIndex += 1) {
      var anchor = normalizeLocalAnchor(sourceAnchors[anchorIndex]);
      if (anchor) anchors.push(anchor);
    }
    return {
      id: id,
      clientId: strokeClientId,
      baseRevision: baseRevision,
      createdAt: Math.round(createdAt),
      surfaceWidth: isFinite(surfaceWidth) && surfaceWidth > 0 ? Math.round(surfaceWidth) : 0,
      surfaceHeight: isFinite(surfaceHeight) && surfaceHeight > 0 ? Math.round(surfaceHeight) : 0,
      order: isFinite(order) && order > 0 ? Math.round(order) : 0,
      sent: !!raw.sent,
      anchors: anchors,
      points: points
    };
  }

  function normalizeStrokeList(value) {
    var source = Object.prototype.toString.call(value) === "[object Array]" ? value : [];
    var result = [];
    for (var i = 0; i < source.length && result.length < 500; i += 1) {
      var stroke = normalizeLocalStroke(source[i], i);
      if (stroke) result.push(stroke);
    }
    return result;
  }

  function matchingRevisionStrokes(source, pageRevision) {
    var matching = [];
    for (var i = 0; i < source.length; i += 1) {
      if (!source[i].baseRevision || !pageRevision || source[i].baseRevision === pageRevision) matching.push(source[i]);
    }
    return matching;
  }

  function localUndoIndex() {
    for (var i = strokes.length - 1; i >= 0; i -= 1) if (strokes[i].clientId === deviceId) return i;
    return -1;
  }

  function hasPendingAddOperations() {
    var operations = storedInkOperations();
    for (var i = 0; i < operations.length; i += 1) if (operations[i].type === "add") return true;
    return false;
  }

  function updateInkButtons() {
    undoInkBtn.disabled = sendBusy || !!pendingInkSend || localUndoIndex() < 0;
    clearInkBtn.disabled = sendBusy || (!strokes.length && !pendingInkSend);
    drawModeBtn.disabled = sendBusy || !!pendingInkSend;
    var cannotSend = sendBusy || !inkSyncReady || hasPendingAddOperations() || (!pendingInkSend && !strokes.length);
    if (sendInkBtn) sendInkBtn.disabled = cannotSend;
    if (liveSendBtn) liveSendBtn.disabled = cannotSend;
    if (copyInkBtn) copyInkBtn.disabled = sendBusy || !strokes.length;
    if (pasteInkBtn) pasteInkBtn.disabled = sendBusy || !inkClipboard.length;
    if (rotateInkBtn) rotateInkBtn.disabled = sendBusy || !selectedStrokeIds.length;
    var selectionActions=document.getElementsByClassName?document.getElementsByClassName("selectionAction"):[]; for(var sa=0;sa<selectionActions.length;sa+=1)selectionActions[sa].hidden=!selectedStrokeIds.length;
    if(deleteSelectionBtn)deleteSelectionBtn.disabled=sendBusy||!selectedStrokeIds.length;
    if(moveSelectionBtn)moveSelectionBtn.disabled=sendBusy||!selectedStrokeIds.length;
    if(askSelectionBtn)askSelectionBtn.disabled=sendBusy||!selectedStrokeIds.length;
  }

  function saveInk() {
    storageSet(INK_STORAGE_KEY, JSON.stringify(strokes.slice(-500)));
    updateInkButtons();
  }

  function storedInkOperations() {
    var result = [];
    try {
      for (var i = 0; i < window.localStorage.length; i += 1) {
        var key = window.localStorage.key(i);
        if (!key || key.indexOf(INK_OP_PREFIX) !== 0) continue;
        try {
          var operation = JSON.parse(window.localStorage.getItem(key) || "null");
          if (operation && validSyncId(operation.id)) result.push(operation);
        } catch (error) {}
      }
    } catch (error) {}
    for (var volatileIndex = 0; volatileIndex < volatileInkOperations.length; volatileIndex += 1) {
      var duplicate = false;
      for (var storedIndex = 0; storedIndex < result.length; storedIndex += 1) {
        if (result[storedIndex].id === volatileInkOperations[volatileIndex].id) duplicate = true;
      }
      if (!duplicate) result.push(volatileInkOperations[volatileIndex]);
    }
    result.sort(function (left, right) {
      var timeDifference = Number(left.createdAt || 0) - Number(right.createdAt || 0);
      if (timeDifference) return timeDifference;
      return String(left.id).localeCompare(String(right.id));
    });
    return result;
  }

  function storeInkOperation(operation) {
    if (storageSet(INK_OP_PREFIX + operation.id, JSON.stringify(operation))) return true;
    for (var i = 0; i < volatileInkOperations.length; i += 1) {
      if (volatileInkOperations[i].id === operation.id) return false;
    }
    volatileInkOperations.push(operation);
    return false;
  }

  function removeInkOperations(operations) {
    var removed = {};
    for (var i = 0; i < operations.length; i += 1) {
      removed[operations[i].id] = true;
      storageRemove(INK_OP_PREFIX + operations[i].id);
    }
    var kept = [];
    for (var v = 0; v < volatileInkOperations.length; v += 1) {
      if (!removed[volatileInkOperations[v].id]) kept.push(volatileInkOperations[v]);
    }
    volatileInkOperations = kept;
  }

  function queueInkOperation(type, payload) {
    var operation = {
      id: nextInkId("op"),
      type: type,
      createdAt: (new Date()).getTime()
    };
    if (type === "add") operation.stroke = copyValue(payload.stroke);
    else operation.ids = payload.ids.slice(0);
    var durable = storeInkOperation(operation);
    if (!durable) setText(stateEl, "Ink is waiting to sync");
    updateInkButtons();
    flushInkOperations();
    return durable;
  }

  function loadInk() {
    deviceId = ensureDeviceId();
    pendingInkSend = readPendingInkSend();
    var saved = [];
    try { saved = JSON.parse(storageGet(INK_STORAGE_KEY) || "[]"); } catch (error) {}
    strokes = normalizeStrokeList(saved);
    startupInkStrokes = copyValue(strokes);
    serverInkStrokes = copyValue(strokes);
    if (storageGet(INK_MIGRATION_KEY) !== "1") {
      var migrated = true;
      for (var i = 0; i < strokes.length; i += 1) {
        var operation = {
          id: "migrate-" + deviceId + "-" + i.toString(36),
          type: "add",
          createdAt: i,
          stroke: copyValue(strokes[i])
        };
        if (!storeInkOperation(operation)) migrated = false;
      }
      if (migrated) storageSet(INK_MIGRATION_KEY, "1");
    }
    saveInk();
  }

  function operationHasId(operation, id) {
    var ids = operation && operation.ids ? operation.ids : [];
    for (var i = 0; i < ids.length; i += 1) if (ids[i] === id) return true;
    return false;
  }

  function applyPendingOperations(base, operations) {
    var result = normalizeStrokeList(base);
    for (var o = 0; o < operations.length; o += 1) {
      var operation = operations[o];
      if (operation.type === "add" && operation.stroke) {
        var added = normalizeLocalStroke(operation.stroke, result.length);
        if (!added) continue;
        var exists = false;
        for (var a = 0; a < result.length; a += 1) if (result[a].id === added.id) exists = true;
        if (!exists) result.push(added);
      } else if (operation.type === "delete") {
        var kept = [];
        for (var d = 0; d < result.length; d += 1) if (!operationHasId(operation, result[d].id)) kept.push(result[d]);
        result = kept;
      } else if (operation.type === "mark-sent") {
        for (var m = 0; m < result.length; m += 1) if (operationHasId(operation, result[m].id)) result[m].sent = true;
      }
    }
    return result.slice(-500);
  }

  function pendingAddExists(operations, id) {
    for (var i = 0; i < operations.length; i += 1) {
      if (operations[i].type === "add" && operations[i].stroke && operations[i].stroke.id === id) return true;
    }
    return false;
  }

  function recoverStartupInk() {
    if (startupInkRecovered) return;
    startupInkRecovered = true;
    var pending = storedInkOperations();
    for (var i = 0; i < startupInkStrokes.length; i += 1) {
      var id = startupInkStrokes[i].id;
      var onServer = false;
      for (var serverIndex = 0; serverIndex < serverInkStrokes.length; serverIndex += 1) {
        if (serverInkStrokes[serverIndex].id === id) onServer = true;
      }
      if (!onServer && !pendingAddExists(pending, id)) queueInkOperation("add", { stroke: startupInkStrokes[i] });
    }
    startupInkStrokes = [];
  }

  function rematerializeInk() {
    if (drawing) return;
    strokes = matchingRevisionStrokes(applyPendingOperations(serverInkStrokes, storedInkOperations()), revision);
    saveInk();
    redrawInk();
  }

  function applyInkSnapshot(snapshot) {
    if (!snapshot || !/^ink:[0-9]+$/.test(String(snapshot.revision || ""))) return;
    if (drawing) {
      pendingInkSnapshot = copyValue(snapshot);
      return;
    }
    var snapshotActiveRevision = String(snapshot.activeRevision || "");
    inkActiveRevision = snapshotActiveRevision;
    if (revision && snapshotActiveRevision && snapshotActiveRevision !== revision) {
      scheduleInkPoll(500);
      return;
    }
    pendingInkSnapshot = null;
    inkSyncRevision = String(snapshot.revision);
    serverInkStrokes = normalizeStrokeList(snapshot.strokes);
    if (revision && snapshotActiveRevision === revision) {
      serverInkStrokes = matchingRevisionStrokes(serverInkStrokes, revision);
    }
    recoverStartupInk();
    rematerializeInk();
  }

  function scheduleInkPoll(delay) {
    if (inkPollTimer) window.clearTimeout(inkPollTimer);
    inkPollTimer = window.setTimeout(function () { refreshInkFromServer(false); }, (typeof document.hidden !== "undefined" && document.hidden) ? 30000 : (delay || 5000));
  }

  function refreshInkFromServer(force) {
    if (inkSyncLoading || inkSyncPosting) return;
    if (drawing) {
      scheduleInkPoll(1500);
      return;
    }
    inkSyncLoading = true;
    var xhr = new XMLHttpRequest();
    xhr.open("GET", "/api/live-page/ink", true);
    xhr.setRequestHeader("accept", "application/json");
    if (!force && inkSyncRevision) xhr.setRequestHeader("if-none-match", "\"" + inkSyncRevision + "\"");
    setAuth(xhr);
    xhr.timeout = 20000;
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) return;
      inkSyncLoading = false;
      if (xhr.status === 304) {
        inkSyncReady = true;
        inkSyncBackoff = 5000;
        flushInkOperations();
        scheduleInkPoll(5000);
        return;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          var result = JSON.parse(xhr.responseText);
          if (!result.ok || !result.ink) throw new Error("Missing ink snapshot");
          inkSyncReady = true;
          inkSyncBackoff = 5000;
          applyInkSnapshot(result.ink);
          flushInkOperations();
        } catch (error) {}
        scheduleInkPoll(5000);
        return;
      }
      inkSyncBackoff = Math.min(30000, Math.max(5000, inkSyncBackoff * 2));
      scheduleInkPoll(inkSyncBackoff);
    };
    xhr.onerror = function () {
      inkSyncLoading = false;
      inkSyncBackoff = Math.min(30000, Math.max(5000, inkSyncBackoff * 2));
      scheduleInkPoll(inkSyncBackoff);
    };
    xhr.ontimeout = xhr.onerror;
    xhr.send(null);
  }

  function nextInkBatch() {
    var operations = storedInkOperations();
    var result = [];
    var totalChars = 0;
    var limit = Math.min(50, Math.max(1, inkBatchLimit));
    for (var i = 0; i < operations.length && result.length < limit; i += 1) {
      var operationChars = JSON.stringify(operations[i]).length + 1;
      if (result.length && totalChars + operationChars > 1200000) break;
      result.push(operations[i]);
      totalChars += operationChars;
    }
    return result;
  }

  function flushInkOperations() {
    if (!inkSyncReady || inkSyncLoading || inkSyncPosting || drawing) return;
    var pending = nextInkBatch();
    if (!pending.length) return;
    inkSyncPosting = true;
    var xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/live-page/ink", true);
    xhr.setRequestHeader("content-type", "application/json");
    xhr.setRequestHeader("accept", "application/json");
    setAuth(xhr);
    xhr.timeout = 20000;
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) return;
      inkSyncPosting = false;
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          var result = JSON.parse(xhr.responseText);
          if (!result.ok || !result.ink) throw new Error("Missing ink snapshot");
          removeInkOperations(pending);
          inkBatchLimit = 50;
          inkSyncBackoff = 5000;
          applyInkSnapshot(result.ink);
          if (storedInkOperations().length) window.setTimeout(flushInkOperations, 0);
          else scheduleInkPoll(5000);
          return;
        } catch (error) {}
      }
      if (xhr.status === 400 || xhr.status === 409 || xhr.status === 413) {
        if (pending.length > 1) {
          inkBatchLimit = Math.max(1, Math.floor(pending.length / 2));
        } else {
          var rejected = pending[0];
          var detail = "";
          try { detail = JSON.parse(xhr.responseText).error || ""; } catch (error) {}
          storageSet(INK_REJECTED_PREFIX + rejected.id, JSON.stringify({ operation: rejected, error: detail }));
          removeInkOperations([rejected]);
          inkBatchLimit = 50;
          setText(stateEl, "One ink change could not sync");
          rematerializeInk();
        }
        window.setTimeout(flushInkOperations, 0);
        return;
      }
      inkSyncBackoff = Math.min(30000, Math.max(5000, inkSyncBackoff * 2));
      scheduleInkPoll(inkSyncBackoff);
    };
    xhr.onerror = function () {
      inkSyncPosting = false;
      inkSyncBackoff = Math.min(30000, Math.max(5000, inkSyncBackoff * 2));
      scheduleInkPoll(inkSyncBackoff);
    };
    xhr.ontimeout = xhr.onerror;
    xhr.send(JSON.stringify({ clientId: deviceId, ops: pending }));
  }

  var SVG_NS = "http://www.w3.org/2000/svg";

  function smoothedStrokePoints(points) {
    if (!points || points.length < 3) return points || [];
    var result = [points[0]];
    for (var i = 1; i < points.length - 1; i += 1) {
      result.push({
        x: (points[i - 1].x + (2 * points[i].x) + points[i + 1].x) / 4,
        y: (points[i - 1].y + (2 * points[i].y) + points[i + 1].y) / 4
      });
    }
    result.push(points[points.length - 1]);
    return result;
  }

  function strokePathData(points) {
    points = smoothedStrokePoints(points);
    var path = ["M", points[0].x * canvasEl.width, points[0].y * canvasEl.height];
    if (points.length === 2) {
      path.push("L", points[1].x * canvasEl.width, points[1].y * canvasEl.height);
      return path.join(" ");
    }
    for (var i = 1; i < points.length - 1; i += 1) {
      var point = points[i];
      var next = points[i + 1];
      path.push(
        "Q",
        point.x * canvasEl.width,
        point.y * canvasEl.height,
        ((point.x + next.x) / 2) * canvasEl.width,
        ((point.y + next.y) / 2) * canvasEl.height
      );
    }
    var last = points[points.length - 1];
    path.push("L", last.x * canvasEl.width, last.y * canvasEl.height);
    return path.join(" ");
  }

  function drawStroke(stroke) {
    var points = stroke && stroke.points ? stroke.points : [];
    if (!points.length) return;
    var element;
    if (points.length === 1) {
      element = document.createElementNS(SVG_NS, "circle");
      element.setAttribute("cx", points[0].x * canvasEl.width);
      element.setAttribute("cy", points[0].y * canvasEl.height);
      element.setAttribute("r", "1.8");
      element.setAttribute("fill", inkColor());
      displayEl.appendChild(element);
      return element;
    }
    element = document.createElementNS(SVG_NS, "path");
    element.setAttribute("d", strokePathData(points));
    element.setAttribute("fill", "none");
    element.setAttribute("stroke", inkColor());
    element.setAttribute("stroke-width", "3");
    element.setAttribute("stroke-linecap", "round");
    element.setAttribute("stroke-linejoin", "round");
    displayEl.appendChild(element);
    return element;
  }

  function redrawInk() {
    while (displayEl.firstChild) displayEl.removeChild(displayEl.firstChild);
    displayEl.setAttribute("viewBox", "0 0 " + canvasEl.width + " " + canvasEl.height);
    displayEl.setAttribute("preserveAspectRatio", "none");
    for (var i = 0; i < strokes.length; i += 1) { var el=drawStroke(strokes[i]); if(selectedStrokeIds.indexOf(strokes[i].id)>=0) el.setAttribute("class","selectedInk"); }
    if (emptyHintEl) emptyHintEl.hidden = emptyHintDismissed || strokes.length > 0;
    if (drawing && currentStroke) currentDisplayEl = displayEl.lastChild;
  }
  function exportInk(selected) {
    if (!selected || !selected.length) return "";
    var width = Math.max(1, canvasEl.width);
    var height = Math.max(1, canvasEl.height);
    var scale = Math.min(1, 900 / Math.max(width, height));
    var out = document.createElement("canvas");
    out.width = Math.max(1, Math.round(width * scale));
    out.height = Math.max(1, Math.round(height * scale));
    var outInk = out.getContext("2d");
    outInk.fillStyle = "#fbfaf4";
    outInk.fillRect(0, 0, out.width, out.height);
    outInk.strokeStyle = "#111";
    outInk.fillStyle = "#111";
    outInk.lineWidth = Math.max(1.2, 3 * scale);
    outInk.lineCap = "round";
    outInk.lineJoin = "round";
    for (var i = 0; i < selected.length; i += 1) {
      var points = smoothedStrokePoints(selected[i].points || []);
      if (!points.length) continue;
      var firstX = points[0].x * width * scale;
      var firstY = points[0].y * height * scale;
      if (points.length === 1) {
        outInk.beginPath();
        outInk.arc(firstX, firstY, Math.max(1.2, 1.8 * scale), 0, Math.PI * 2);
        outInk.fill();
        continue;
      }
      outInk.beginPath();
      outInk.moveTo(firstX, firstY);
      if (points.length === 2) {
        outInk.lineTo(points[1].x * width * scale, points[1].y * height * scale);
      } else {
        for (var j = 1; j < points.length - 1; j += 1) {
          var point = points[j];
          var next = points[j + 1];
          outInk.quadraticCurveTo(
            point.x * width * scale,
            point.y * height * scale,
            ((point.x + next.x) / 2) * width * scale,
            ((point.y + next.y) / 2) * height * scale
          );
        }
        var last = points[points.length - 1];
        outInk.lineTo(last.x * width * scale, last.y * height * scale);
      }
      outInk.stroke();
    }
    return out.toDataURL("image/jpeg", 0.8);
  }

  function resizeCanvas() {
    var rect = surfaceEl.getBoundingClientRect();
    canvasEl.width = Math.max(1, Math.round(rect.width));
    canvasEl.height = Math.max(1, Math.round(rect.height));
    redrawInk();
  }

  function pointFromEvent(event) {
    var rect = canvasEl.getBoundingClientRect();
    var source = event.touches && event.touches[0] ? event.touches[0] : event;
    if (event.changedTouches && event.changedTouches[0]) source = event.changedTouches[0];
    return {
      x: Math.max(0, Math.min(1, (source.clientX - rect.left) / Math.max(1, rect.width))),
      y: Math.max(0, Math.min(1, (source.clientY - rect.top) / Math.max(1, rect.height)))
    };
  }

  function selectorAttribute(value) {
    return String(value || "").replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
  }

  function domSelector(element, doc) {
    if (!element || !doc) return "";
    var region = element.getAttribute && element.getAttribute("data-live-region");
    if (region) return '[data-live-region="' + selectorAttribute(region) + '"]';
    var id = element.getAttribute && element.getAttribute("id");
    if (id) return '[id="' + selectorAttribute(id) + '"]';
    var parts = [];
    var node = element;
    while (node && node.nodeType === 1 && node !== doc.body && parts.length < 6) {
      var tag = String(node.tagName || "div").toLowerCase();
      var index = 1;
      var sibling = node.previousElementSibling;
      while (sibling) {
        if (String(sibling.tagName || "").toLowerCase() === tag) index += 1;
        sibling = sibling.previousElementSibling;
      }
      parts.unshift(tag + ":nth-of-type(" + index + ")");
      node = node.parentElement;
      if (node && node.getAttribute) {
        var ancestorRegion = node.getAttribute("data-live-region");
        var ancestorId = node.getAttribute("id");
        if (ancestorRegion) {
          parts.unshift('[data-live-region="' + selectorAttribute(ancestorRegion) + '"]');
          break;
        }
        if (ancestorId) {
          parts.unshift('[id="' + selectorAttribute(ancestorId) + '"]');
          break;
        }
      }
    }
    return parts.join(" > ");
  }

  function meaningfulDomElement(element, doc) {
    var node = element;
    while (node && node.nodeType === 1 && node !== doc.body && node !== doc.documentElement) {
      var tag = String(node.tagName || "").toLowerCase();
      var text = String(node.textContent || "").replace(/\s+/g, " ").trim();
      if ((node.getAttribute && (node.getAttribute("data-live-region") || node.getAttribute("id"))) ||
          /^(a|article|aside|blockquote|button|caption|code|dd|dt|figcaption|figure|h[1-6]|img|label|li|main|nav|p|pre|section|summary|table|tbody|td|th|thead|tr)$/.test(tag) ||
          (text && node.children && node.children.length === 0)) return node;
      node = node.parentElement;
    }
    return null;
  }

  function captureStrokeAnchors(stroke) {
    var points = stroke && stroke.points ? stroke.points : [];
    if (!points.length) return [];
    var doc;
    try {
      doc = frameEl.contentDocument || (frameEl.contentWindow && frameEl.contentWindow.document);
    } catch (error) {
      return [];
    }
    if (!doc || !doc.documentElement || typeof doc.elementFromPoint !== "function") return [];
    var width = Math.max(1, Number(doc.documentElement.clientWidth) || Number(frameEl.clientWidth) || canvasEl.width);
    var height = Math.max(1, Number(doc.documentElement.clientHeight) || Number(frameEl.clientHeight) || canvasEl.height);
    var minX = 1;
    var minY = 1;
    var maxX = 0;
    var maxY = 0;
    var averageX = 0;
    var averageY = 0;
    for (var i = 0; i < points.length; i += 1) {
      minX = Math.min(minX, points[i].x);
      minY = Math.min(minY, points[i].y);
      maxX = Math.max(maxX, points[i].x);
      maxY = Math.max(maxY, points[i].y);
      averageX += points[i].x;
      averageY += points[i].y;
    }
    averageX /= points.length;
    averageY /= points.length;
    var hits = {};
    function sample(x, y, centered) {
      var element;
      try { element = meaningfulDomElement(doc.elementFromPoint(x * width, y * height), doc); } catch (error) { return; }
      if (!element) return;
      var selector = domSelector(element, doc);
      if (!selector) return;
      var rect = element.getBoundingClientRect();
      var key = selector;
      if (!hits[key]) {
        hits[key] = {
          selector: selector,
          tag: String(element.tagName || "").toLowerCase().slice(0, 32),
          text: String(element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 240),
          rect: {
            x: Math.max(0, Math.min(1, rect.left / width)),
            y: Math.max(0, Math.min(1, rect.top / height)),
            width: Math.max(0, Math.min(1, rect.width / width)),
            height: Math.max(0, Math.min(1, rect.height / height))
          },
          hitCount: 0,
          centered: false
        };
      }
      hits[key].hitCount += 1;
      if (centered) hits[key].centered = true;
    }
    var stride = Math.max(1, Math.ceil(points.length / 20));
    for (var pointIndex = 0; pointIndex < points.length; pointIndex += stride) sample(points[pointIndex].x, points[pointIndex].y, false);
    sample((minX + maxX) / 2, (minY + maxY) / 2, true);
    sample(averageX, averageY, true);
    var result = [];
    for (var key in hits) if (Object.prototype.hasOwnProperty.call(hits, key)) result.push(hits[key]);
    result.sort(function (left, right) {
      if (left.centered !== right.centered) return left.centered ? -1 : 1;
      if (left.hitCount !== right.hitCount) return right.hitCount - left.hitCount;
      return left.selector.length - right.selector.length;
    });
    return result.slice(0, 6);
  }

  function startInk(event) {
    if (!drawMode || sendBusy || pendingInkSend) return true;
    emptyHintDismissed = true;
    if (emptyHintEl) emptyHintEl.hidden = true;
    // Fast pen input can deliver the next down before the previous up is
    // observed. Persist that completed geometry instead of orphaning it when
    // currentStroke is replaced below.
    if (drawing && currentStroke) commitCurrentStroke();
    if(moveMode&&selectedStrokeIds.length){movingSelection=true;moveStart=pointFromEvent(event);moveOriginals=[];for(var mi=0;mi<strokes.length;mi+=1)if(selectedStrokeIds.indexOf(strokes[mi].id)>=0)moveOriginals.push({index:mi,stroke:JSON.parse(JSON.stringify(strokes[mi]))});return stopEvent(event);}
    if (lassoMode) { lassoing = true; lassoPoints = [pointFromEvent(event)]; return stopEvent(event); }
    if (eraserMode) {
      var eraserPoint = pointFromEvent(event), removedIds = [];
      for (var eraseIndex = strokes.length - 1; eraseIndex >= 0; eraseIndex -= 1) {
        var erasePoints = strokes[eraseIndex].points || [], hit = false;
        for (var ep = 0; ep < erasePoints.length; ep += 1) {
          if (Math.abs(erasePoints[ep].x - eraserPoint.x) < .025 && Math.abs(erasePoints[ep].y - eraserPoint.y) < .025) { hit = true; break; }
        }
        if (hit) { removedIds.push(strokes[eraseIndex].id); strokes.splice(eraseIndex, 1); }
      }
      if (removedIds.length) { redrawInk(); saveInk(); queueInkOperation("delete", { ids: removedIds }); }
      updateInkButtons();
      return stopEvent(event);
    }
    if (event.pointerId !== undefined && canvasEl.setPointerCapture) {
      try { canvasEl.setPointerCapture(event.pointerId); } catch (error) {}
    }
    var startedAt = (new Date()).getTime();
    var firstPoint = pointFromEvent(event);
    firstPoint.t = 0;
    currentStroke = {
      id: nextInkId("stroke"),
      clientId: deviceId,
      baseRevision: /^sha256:[a-f0-9]{64}$/.test(revision) ? revision : "",
      createdAt: startedAt,
      surfaceWidth: canvasEl.width,
      surfaceHeight: canvasEl.height,
      sent: false,
      points: [firstPoint]
    };
    strokes.push(currentStroke);
    drawing = true;
    currentDisplayEl = drawStroke(currentStroke);
    updateInkButtons();
    return stopEvent(event);
  }

  function appendInkPoint(event) {
    var point = pointFromEvent(event);
    point.t = Math.max(0, Math.min(MAX_POINT_T, (new Date()).getTime() - currentStroke.createdAt));
    var previous = currentStroke.points[currentStroke.points.length - 1];
    if (currentStroke.points.length < 1200 && Math.abs(point.x - previous.x) + Math.abs(point.y - previous.y) > 0.0015) {
      currentStroke.points.push(point);
      return true;
    }
    return false;
  }

  function moveInk(event) {
    if(movingSelection){movePreviewPoint=pointFromEvent(event);if(!movePreviewFrame)movePreviewFrame=requestFrame(renderMovePreview);return stopEvent(event);}
    if (lassoing) { lassoPoints.push(pointFromEvent(event)); return stopEvent(event); }
    if (!drawing || !currentStroke) return stopEvent(event);
    var samples = [event];
    if (typeof event.getCoalescedEvents === "function") {
      try {
        var coalesced = event.getCoalescedEvents();
        if (coalesced && coalesced.length) samples = coalesced;
      } catch (error) {}
    }
    var changed = false;
    for (var i = 0; i < samples.length && currentStroke.points.length < 1200; i += 1) {
      if (appendInkPoint(samples[i])) changed = true;
    }
    if (changed) {
      if (currentStroke.points.length === 2 || !currentDisplayEl || String(currentDisplayEl.tagName || "").toLowerCase() !== "path") {
        redrawInk();
      } else {
        currentDisplayEl.setAttribute("d", strokePathData(currentStroke.points));
      }
    }
    return stopEvent(event);
  }

  function commitCurrentStroke() {
    if (!drawing || !currentStroke) return;
    var completed = currentStroke;
    completed.anchors = captureStrokeAnchors(completed);
    drawing = false;
    currentStroke = null;
    currentDisplayEl = null;
    saveInk();
    queueInkOperation("add", { stroke: completed });
    if (pendingInkSnapshot) {
      var snapshot = pendingInkSnapshot;
      pendingInkSnapshot = null;
      applyInkSnapshot(snapshot);
    }
  }

  function endInk(event) {
    if(movingSelection){movePreviewPoint=pointFromEvent(event);renderMovePreview();movingSelection=false;var oldIds=[],newIds=[];for(var mm=0;mm<moveOriginals.length;mm+=1){oldIds.push(moveOriginals[mm].stroke.id);var moved=strokes[moveOriginals[mm].index];moved.id=nextInkId("stroke");moved.sent=false;newIds.push(moved.id);queueInkOperation("add",{stroke:moved});}queueInkOperation("delete",{ids:oldIds});selectedStrokeIds=newIds;moveMode=false;if(moveSelectionBtn)moveSelectionBtn.className="selectionAction";setText(annotationToggleBtn,"Pen");saveInk();redrawInk();updateInkButtons();setText(stateEl,"Selection moved");return stopEvent(event);}
    if (lassoing) {
      lassoing = false;
      if (lassoPoints.length > 2) {
        selectedStrokeIds=[];
        for (var ls=0; ls<strokes.length; ls+=1) { var pts=strokes[ls].points||[], inside=false; for(var sp=0;sp<pts.length;sp+=1){if(pointInPolygon(pts[sp],lassoPoints)){inside=true;break;}} if(inside)selectedStrokeIds.push(strokes[ls].id); }
      }
      redrawInk(); setText(stateEl, selectedStrokeIds.length ? selectedStrokeIds.length + " selected" : "Nothing selected"); updateInkButtons(); return stopEvent(event);
    }
    if (!drawing) return stopEvent(event);
    var eventType = String(event && event.type || "").toLowerCase();
    var hasFinalPoint = event && (
      typeof event.clientX === "number" ||
      (event.changedTouches && event.changedTouches[0])
    );
    if (hasFinalPoint && (eventType.indexOf("up") >= 0 || eventType === "touchend")) {
      appendInkPoint(event);
    }
    commitCurrentStroke();
    if (pendingPage) {
      var page = pendingPage;
      pendingPage = null;
      openRevision(page);
    }
    return stopEvent(event);
  }

  function bindInkEvents(element) {
    if (window.PointerEvent) {
      add(element, "pointerdown", startInk);
      add(element, "pointermove", moveInk);
      add(element, "pointerup", endInk);
      add(element, "pointercancel", endInk);
      // Pointer capture keeps a fast edge stroke alive outside the canvas.
      // A document fallback covers older implementations that lose capture.
      add(document, "pointerup", endInk);
    } else if (window.MSPointerEvent) {
      add(element, "MSPointerDown", startInk);
      add(element, "MSPointerMove", moveInk);
      add(element, "MSPointerUp", endInk);
    } else if ("ontouchstart" in window) {
      add(element, "touchstart", startInk);
      add(element, "touchmove", moveInk);
      add(element, "touchend", endInk);
      add(element, "touchcancel", endInk);
    } else {
      add(element, "mousedown", startInk);
      add(element, "mousemove", moveInk);
      add(element, "mouseup", endInk);
      add(element, "mouseleave", endInk);
      add(document, "mouseup", endInk);
    }
  }

  function clearInk() {
    clearPendingInkSend();
    var ids = [];
    for (var i = 0; i < strokes.length; i += 1) if (validSyncId(strokes[i].id)) ids.push(strokes[i].id);
    strokes = [];
    currentStroke = null;
    drawing = false;
    redrawInk();
    saveInk();
    if (ids.length) queueInkOperation("delete", { ids: ids });
  }

  function undoInk() {
    var index = localUndoIndex();
    if (index < 0) return;
    var id = strokes[index].id;
    strokes.splice(index, 1);
    redrawInk();
    saveInk();
    queueInkOperation("delete", { ids: [id] });
  }

  function updateBodyMode() {
    document.body.className = "livePage " +
      (drawMode ? "drawMode" : "viewMode") + " " +
      (toolsOpen ? "toolsOpen" : "toolsCollapsed");
  }

  function setDrawMode(enabled) {
    drawMode = !!enabled;
    if(drawMode&&!eraserMode&&!lassoMode&&!moveMode)setText(annotationToggleBtn,"Pen");
    updateBodyMode();
    setText(drawModeBtn, drawMode ? "Done" : "Draw");
    drawModeBtn.className = drawMode ? "active" : "";
    drawModeBtn.setAttribute("aria-pressed", drawMode ? "true" : "false");
    if (!drawMode && drawing) commitCurrentStroke();
  }

  function setToolsOpen(enabled) {
    toolsOpen = !!enabled;
    if (annotationToolsEl) annotationToolsEl.hidden = !toolsOpen;
    if (annotationToggleBtn) {
      annotationToggleBtn.setAttribute("aria-expanded", toolsOpen ? "true" : "false");
      annotationToggleBtn.setAttribute("aria-label", toolsOpen ? "Close annotation tools" : "Open annotation tools");
    }
    updateBodyMode();
  }

  function accessQuery() {
    var values = [];
    if (remoteKey) values.push("rk=" + encodeURIComponent(remoteKey));
    else if (authTok) values.push("k=" + encodeURIComponent(authTok));
    values.push("revision=" + encodeURIComponent(revision));
    values.push("theme=" + (darkMode ? "dark" : "light"));
    return "?" + values.join("&");
  }

  function formatUpdated(page) {
    if (!page.updatedAt) return page.title || "Living HTML";
    try { return (page.title || "Living HTML") + " · " + (new Date(page.updatedAt)).toLocaleTimeString(); }
    catch (error) { return page.title || "Living HTML"; }
  }

  function showMessage(text) {
    setText(messageEl, text);
    messageEl.className = "liveMessage";
  }

  function hideMessage() {
    messageEl.className = "liveMessage hidden";
  }
  function showReply(text, intent) {
    emptyHintDismissed = true;
    if (emptyHintEl) emptyHintEl.hidden = true;
    var isRedline = intent === "redline";
    replyEl.className = isRedline ? "liveReply redlineReply" : "liveReply";
    setText(replyKindEl, isRedline ? "Hermes redline suggestion" : "Hermes");
    setText(replyTextEl, text || "Hermes finished.");
    replyEl.hidden = false;
  }
  function renderMovePreview(){movePreviewFrame=null;if(!movingSelection||!movePreviewPoint)return;var dx=movePreviewPoint.x-moveStart.x,dy=movePreviewPoint.y-moveStart.y;for(var mo=0;mo<moveOriginals.length;mo+=1){var original=moveOriginals[mo].stroke,current=strokes[moveOriginals[mo].index];for(var mpt=0;mpt<original.points.length;mpt+=1){current.points[mpt].x=Math.max(0,Math.min(1,original.points[mpt].x+dx));current.points[mpt].y=Math.max(0,Math.min(1,original.points[mpt].y+dy));}}redrawInk();}
  function requestClear(){if(!clearArmed){clearArmed=true;setText(clearInkBtn,"Tap again to clear");setText(stateEl,"Clear all ink?");if(clearTimer)window.clearTimeout(clearTimer);clearTimer=window.setTimeout(function(){clearArmed=false;setText(clearInkBtn,"Clear ink");},4000);return;}clearArmed=false;if(clearTimer)window.clearTimeout(clearTimer);setText(clearInkBtn,"Clear ink");clearInk();}
  function pointInPolygon(point, polygon){var inside=false;for(var i=0,j=polygon.length-1;i<polygon.length;j=i++){var a=polygon[i],b=polygon[j];if(((a.y>point.y)!==(b.y>point.y))&&(point.x<(b.x-a.x)*(point.y-a.y)/(b.y-a.y||.000001)+a.x))inside=!inside;}return inside;}
  function closeMenus(except) { var menus=[["pen",annotationToolsEl,annotationToggleBtn],["hermes",hermesToolsEl,hermesToggleBtn],["more",moreToolsEl,moreToggleBtn]]; for(var i=0;i<menus.length;i+=1){if(menus[i][0]!==except){menus[i][1].hidden=true;menus[i][2].setAttribute("aria-expanded","false");}} }
  function toggleMenu(name, menu, button) { var opening=menu.hidden; closeMenus(name); menu.hidden=!opening; button.setAttribute("aria-expanded",opening?"true":"false"); if(name==="pen")toolsOpen=opening; }

  function toggleEraser() {
    eraserMode = !eraserMode;
    if (eraserInkBtn) eraserInkBtn.className = eraserMode ? "labeledTool active" : "labeledTool";
    if (eraserMode && !drawMode) setDrawMode(true);
    setText(stateEl, eraserMode ? "Eraser" : "Pen");
    setText(annotationToggleBtn,eraserMode?"Eraser":"Pen");
  }

  function copyInk() {
    var chosen=[]; for(var i=0;i<strokes.length;i+=1) if(!selectedStrokeIds.length || selectedStrokeIds.indexOf(strokes[i].id)>=0) chosen.push(strokes[i]);
    inkClipboard = JSON.parse(JSON.stringify(chosen));
    setText(stateEl, "Ink copied");
    updateInkButtons();
  }

  function toggleLasso() { lassoMode=!lassoMode; eraserMode=false; if(eraserInkBtn) eraserInkBtn.className="labeledTool"; if(lassoInkBtn) lassoInkBtn.className=lassoMode?"labeledTool active":"labeledTool"; setText(stateEl,lassoMode?"Select":"Pen"); setText(annotationToggleBtn,lassoMode?"Select":"Pen"); }
  function rotateSelection() {
    var chosen=[]; for(var i=0;i<strokes.length;i+=1) if(selectedStrokeIds.indexOf(strokes[i].id)>=0) chosen.push(strokes[i]); if(!chosen.length)return;
    var cx=0,cy=0,n=0; for(var s=0;s<chosen.length;s+=1)for(var p=0;p<chosen[s].points.length;p+=1){cx+=chosen[s].points[p].x;cy+=chosen[s].points[p].y;n+=1;} cx/=n;cy/=n;
    var oldIds=[]; for(var j=0;j<chosen.length;j+=1){oldIds.push(chosen[j].id); var replacement=JSON.parse(JSON.stringify(chosen[j])); replacement.id=nextInkId("stroke"); replacement.sent=false; for(var q=0;q<replacement.points.length;q+=1){var dx=replacement.points[q].x-cx,dy=replacement.points[q].y-cy;replacement.points[q].x=cx-dy;replacement.points[q].y=cy+dx;} strokes[strokes.indexOf(chosen[j])]=replacement; queueInkOperation("add",{stroke:replacement});}
    queueInkOperation("delete",{ids:oldIds}); selectedStrokeIds=[]; redrawInk();saveInk();updateInkButtons();
  }
  function deleteSelection(){if(!selectedStrokeIds.length)return;var ids=selectedStrokeIds.slice(0),kept=[];for(var i=0;i<strokes.length;i+=1)if(ids.indexOf(strokes[i].id)<0)kept.push(strokes[i]);strokes=kept;selectedStrokeIds=[];queueInkOperation("delete",{ids:ids});redrawInk();saveInk();updateInkButtons();setText(stateEl,"Selection deleted");}
  function toggleMoveSelection(){moveMode=!moveMode;lassoMode=false;if(lassoInkBtn)lassoInkBtn.className="labeledTool";if(moveSelectionBtn)moveSelectionBtn.className=moveMode?"selectionAction active":"selectionAction";setText(stateEl,moveMode?"Drag selection to move":"Selection ready");setText(annotationToggleBtn,moveMode?"Move":"Pen");}

  function pasteInk() {
    for (var i = 0; i < inkClipboard.length; i += 1) {
      var pasted = JSON.parse(JSON.stringify(inkClipboard[i]));
      pasted.id = nextInkId("stroke"); pasted.clientId = deviceId; pasted.sent = false; pasted.createdAt = (new Date()).getTime();
      for (var p = 0; p < pasted.points.length; p += 1) { pasted.points[p].x = Math.min(.99, pasted.points[p].x + .03); pasted.points[p].y = Math.min(.99, pasted.points[p].y + .03); }
      pasted.anchors = captureStrokeAnchors(pasted); strokes.push(pasted); queueInkOperation("add", { stroke: pasted });
    }
    redrawInk(); saveInk(); updateInkButtons(); setText(stateEl, "Ink pasted");
  }

  function hideReply() {
    replyEl.hidden = true;
  }

  function setSendBusy(busy) {
    sendBusy = !!busy;
    setText(sendInkBtn, sendBusy ? "Working..." : "Send");
    setText(liveSendBtn, sendBusy ? "Working..." : "Send");
    updateInkButtons();
  }

  function requestJson(method, url, body, callback) {
    var xhr = new XMLHttpRequest();
    xhr.open(method, url, true);
    xhr.setRequestHeader("accept", "application/json");
    if (body !== null) xhr.setRequestHeader("content-type", "application/json");
    setAuth(xhr);
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) return;
      var json = null;
      try { json = JSON.parse(xhr.responseText || "{}"); } catch (error) {}
      callback(xhr.status >= 200 && xhr.status < 300 ? null : new Error((json && json.error) || "Request failed"), json);
    };
    xhr.send(body === null ? null : JSON.stringify(body));
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;");
  }

  function openHistory() {
    liveHistoryEl.hidden = false;
    liveHistoryList.innerHTML = "<p>Loading&hellip;</p>";
    requestJson("GET", "/api/sessions", null, function (error, json) {
      if (error) { liveHistoryList.innerHTML = "<p>History unavailable.</p>"; return; }
      var items = json.sessions || [], html = "";
      if (!items.length) html = "<p>No conversations yet.</p>";
      for (var i = 0; i < items.length; i += 1) html += '<button class="historyItem" data-session="' + escapeHtml(items[i].id) + '"><strong>' + escapeHtml(items[i].title || "Untitled") + '</strong><br>' + escapeHtml(items[i].preview || "") + '</button>';
      liveHistoryList.innerHTML = html;
    });
  }

  function newPage() {
    if (sendBusy || drawing || newPageBusy) return;
    newPageBusy=true;
    var previousThreadId=hermesThreadId;
    setText(stateEl,"Opening blank page");
    requestJson("POST", "/api/live-page/template", { template: "blank", baseRevision: revision, confirm: "replace" }, function (error) {
      newPageBusy=false;
      if (error) { setText(stateEl, "Could not open blank page"); return; }
      sessionId="";hermesThreadId=newHermesThreadId();
      emptyHintDismissed=false;
      storageRemove("diarySessionId");storageSet("diaryHermesThreadId",hermesThreadId);
      clearInk();hideReply();setToolsOpen(false);closeMenus("");
      // Retire the old Hermes lane only after the replacement page exists.
      if(previousThreadId)requestJson("POST","/api/channel/reset",{chatId:previousThreadId},function(){});
      loadMetadata(true);setText(stateEl,"New page");
    });
  }
  function toggleTheme() { darkMode=!darkMode; try { if(darkMode) window.localStorage.setItem("diaryDark","1"); else window.localStorage.removeItem("diaryDark"); } catch(error){} document.documentElement.className=darkMode?"dark":""; setText(liveThemeBtn,darkMode?"Light":"Dark"); if(revision) frameEl.src="/api/live-page/content"+accessQuery(); }

  function startProgress(intent) {
    var phases = ["Received", "Reading the page", "Thinking", "Using Hermes", "Checking for HTML updates"];
    if (intent === "tasks") phases = ["Received", "Finding tasks", "Using Hermes", "Checking the page"];
    if (intent === "email") phases = ["Received", "Drafting", "Using Hermes", "Checking the page"];
    if (intent === "workpaper") phases = ["Received", "Reading marks", "Shaping workpaper notes", "Checking the page"];
    if (intent === "redline") phases = ["Received", "Reading the marked content", "Drafting one suggestion", "Checking the page"];
    progressIndex = 0;
    if (progressTimer) window.clearInterval(progressTimer);
    setText(stateEl, phases[0]);
    progressTimer = window.setInterval(function () {
      progressIndex = Math.min(progressIndex + 1, phases.length - 1);
      setText(stateEl, phases[progressIndex]);
    }, 4500);
  }

  function stopProgress(finalText) {
    if (progressTimer) window.clearInterval(progressTimer);
    progressTimer = null;
    setText(stateEl, finalText || "Hermes finished");
  }

  function newHermesThreadId() {
    return "kindle-live-" + (new Date()).getTime().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }

  function rememberChannel(result) {
    if (result.sessionId) sessionId = result.sessionId;
    if (result.hermesThreadId) hermesThreadId = result.hermesThreadId;
    try {
      if (sessionId) window.localStorage.setItem("diarySessionId", sessionId);
      if (hermesThreadId) window.localStorage.setItem("diaryHermesThreadId", hermesThreadId);
    } catch (error) {}
  }

  function openRevision(page) {
    if (drawing) {
      pendingPage = page;
      return;
    }
    var changedRevision = !!revision && page.revision !== revision;
    if (page.title !== "Blank page") emptyHintDismissed = true;
    var matchingCachedStrokes = matchingRevisionStrokes(strokes, page.revision);
    var staleActiveInk = !revision && inkActiveRevision && inkActiveRevision !== page.revision;
    var staleInitialInk = !revision && (staleActiveInk || matchingCachedStrokes.length !== strokes.length);
    if (changedRevision || staleInitialInk) {
      setToolsOpen(false);
      hideReply();
      currentStroke = null;
      if (changedRevision) {
        strokes = [];
        serverInkStrokes = [];
        startupInkStrokes = [];
      } else {
        strokes = matchingCachedStrokes;
        serverInkStrokes = matchingRevisionStrokes(serverInkStrokes, page.revision);
        startupInkStrokes = matchingRevisionStrokes(startupInkStrokes, page.revision);
      }
      pendingInkSnapshot = null;
      redrawInk();
      saveInk();
    }
    revision = page.revision;
    setText(stateEl, formatUpdated(page));
    document.title = (page.title || "HTML") + " · Hermes";
    showMessage("Opening the new version…");
    frameEl.src = "/api/live-page/content" + accessQuery();
  }
  function schedulePoll() {
    if (pollTimer) window.clearTimeout(pollTimer);
    pollTimer = window.setTimeout(function () { loadMetadata(false); }, (typeof document.hidden !== "undefined" && document.hidden) ? 30000 : 10000);
  }

  function loadMetadata(force) {
    if (loading) return;
    loading = true;
    var xhr = new XMLHttpRequest();
    xhr.open("GET", "/api/live-page", true);
    xhr.setRequestHeader("accept", "application/json");
    if (!force && revision) xhr.setRequestHeader("if-none-match", '"' + revision + '"');
    setAuth(xhr);
    xhr.timeout = 20000;
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) return;
      loading = false;
      if (xhr.status === 304) {
        schedulePoll();
        return;
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        setText(stateEl, "Page unavailable");
        if (!revision) showMessage(xhr.status === 401 ? "Open HTML from your permanent Hermes bookmark." : "The page could not be reached.");
        schedulePoll();
        return;
      }
      try {
        var result = JSON.parse(xhr.responseText);
        if (!result.page || !result.page.revision) throw new Error("Missing page");
        if (result.page.revision !== revision) openRevision(result.page);
      } catch (error) {
        setText(stateEl, "Unreadable page");
        if (!revision) showMessage("The page could not be read.");
      }
      schedulePoll();
    };
    xhr.onerror = function () {
      loading = false;
      setText(stateEl, "Page unavailable");
      if (!revision) showMessage("The page could not be reached.");
      schedulePoll();
    };
    xhr.ontimeout = xhr.onerror;
    xhr.send(null);
  }
  function intentText(intent) {
    if (intent === "summarize") return "Summarize the current HTML page. If I marked it up, use the marks as guidance. Keep the answer short-first.";
    if (intent === "tasks") return "Extract action items from the current HTML page and my marks. Group by owner, due date, and uncertainty.";
    if (intent === "email") return "Draft a concise email from the current HTML page and my marks. Do not send it.";
    if (intent === "workpaper") return "Turn the current HTML page and my marks into a workpaper-ready note: facts, evidence, open items, and risks.";
    if (intent === "redline") return "Suggest one concise, non-destructive replacement for the marked page content, or one concise rationale if replacement is inappropriate. Anchor the suggestion in the marked content. Do not modify the page.";
    return "";
  }

  function sendInkToHermes(intent) {
    if (sendBusy || drawing) return;
    if (!inkSyncReady || hasPendingAddOperations()) {
      setText(stateEl, "Finishing ink sync...");
      flushInkOperations();
      return;
    }
    var retrying = !!pendingInkSend;
    var pending = [];
    var pendingIds = [];
    var liveInkSendId = "";
    if (retrying) {
      liveInkSendId = pendingInkSend.id;
      pendingIds = pendingInkSend.strokeIds.slice(0);
      for (var strokeIndex = 0; strokeIndex < strokes.length; strokeIndex += 1) {
        if (pendingInkSendHasId(strokes[strokeIndex].id)) pending.push(strokes[strokeIndex]);
      }
    } else {
      pending = unsentStrokes();
      if (!pending.length) pending = strokes.slice(0);
      for (var pendingIndex = 0; pendingIndex < pending.length; pendingIndex += 1) pendingIds.push(pending[pendingIndex].id);
      liveInkSendId = nextInkId("send");
    }
    var imageDataUrl = exportInk(pending);
    var requestedIntent = typeof intent === "string" ? intent : "";
    var textInstruction = intentText(requestedIntent);
    if (!imageDataUrl && !retrying && !textInstruction) {
      setText(stateEl, "Write something first");
      return;
    }
    if (!retrying) keepPendingInkSend({ id: liveInkSendId, strokeIds: pendingIds });
    if (!hermesThreadId) hermesThreadId = newHermesThreadId();
    var done = false;
    var useStream = !retrying;
    var streamHeader = false, streamStart = 0, streamText = "", streamTrailer = null;
    setSendBusy(true);
    hideReply();
    startProgress(requestedIntent);
    var xhr = new XMLHttpRequest();

    function finishError(message) {
      if (done) return;
      done = true;
      setSendBusy(false);
      stopProgress("Could not send annotation");
      showReply(message || "The annotation could not be sent. Your ink is still here.");
    }

    xhr.open("POST", "/api/send", true);
    xhr.setRequestHeader("content-type", "application/json");
    xhr.setRequestHeader("accept", "application/json");
    setAuth(xhr);
    xhr.timeout = 300000;
    xhr.onreadystatechange = function () {
      if (useStream && xhr.readyState >= 3 && xhr.responseText) {
        var raw = xhr.responseText;
        if (!streamHeader) { var nl = raw.indexOf("\n"); if (nl >= 0) { try { rememberChannel(JSON.parse(raw.slice(0,nl))); } catch(error){} streamHeader=true; streamStart=nl+1; } }
        if (streamHeader) { var part=raw.slice(streamStart), rs=part.indexOf(String.fromCharCode(30)); if(rs>=0){streamText=part.slice(0,rs);try{streamTrailer=JSON.parse(part.slice(rs+1));}catch(error){}}else streamText=part; if(streamText&&streamText!==lastStreamPaint&&!streamPaintTimer)streamPaintTimer=window.setTimeout(function(){streamPaintTimer=null;lastStreamPaint=streamText;showReply(streamText, requestedIntent);},160); }
      }
      if (xhr.readyState !== 4 || done) return;
      if (xhr.status < 200 || xhr.status >= 300) {
        var errorText = "";
        try { errorText = JSON.parse(xhr.responseText).error || ""; } catch (error) {}
        finishError(errorText);
        return;
      }
      try {
        var result = useStream ? { ok:true, text:streamText, pageChanged:!!(streamTrailer&&streamTrailer.pageChanged), page:streamTrailer&&streamTrailer.page } : JSON.parse(xhr.responseText);
        if (!result.ok) throw new Error(result.error || "Hermes did not complete the annotation");
        done = true;
        for (var i = 0; i < strokes.length; i += 1) {
          for (var sentIndex = 0; sentIndex < pendingIds.length; sentIndex += 1) {
            if (strokes[i].id === pendingIds[sentIndex]) strokes[i].sent = true;
          }
        }
        rememberChannel(result);
        saveInk();
        if (pendingIds.length) queueInkOperation("mark-sent", { ids: pendingIds });
        clearPendingInkSend(liveInkSendId);
        setSendBusy(false);
        stopProgress(result.pageChanged ? "HTML updated" : "Hermes finished");
        showReply(result.text, requestedIntent);
        loadMetadata(true);
      } catch (error) {
        finishError(error.message);
      }
    };
    xhr.onerror = function () { finishError("Network error. Your ink is still here."); };
    xhr.ontimeout = function () { finishError("Hermes took too long. Your ink is still here."); };
    xhr.send(JSON.stringify({
      target: "hermes",
      text: textInstruction,
      imageDataUrl: imageDataUrl,
      intent: requestedIntent,
      sessionId: sessionId || null,
      hermesThreadId: hermesThreadId,
      source: "live-page",
      livePageRevision: revision,
      liveInkSendId: liveInkSendId,
      liveInkStrokeIds: pendingIds,
      resend: !retrying && unsentStrokes().length === 0,
      stream: useStream
    }));
  }

  bindInkEvents(canvasEl);
  add(window, "resize", resizeCanvas);
  add(frameEl, "load", hideMessage);
  add(annotationToggleBtn, "click", function () {
    closeMenus("pen");
    if (!drawMode) setDrawMode(true);
    setToolsOpen(!toolsOpen);
  });
  add(hermesToggleBtn, "click", function () { toggleMenu("hermes", hermesToolsEl, hermesToggleBtn); });
  add(moreToggleBtn, "click", function () { toggleMenu("more", moreToolsEl, moreToggleBtn); });
  add(drawModeBtn, "click", function () { setDrawMode(!drawMode); });
  add(sendInkBtn, "click", function () { sendInkToHermes(""); });
  add(liveSendBtn, "click", function () { sendInkToHermes(""); });
  add(liveHistoryBtn, "click", openHistory);
  add(liveHistoryCloseBtn, "click", function () { liveHistoryEl.hidden = true; });
  add(liveNewBtn, "click", newPage);
  add(liveThemeBtn, "click", toggleTheme);
  add(liveHistoryList, "click", function (event) {
    var target = event.target || event.srcElement;
    if (target && target.getAttribute && target.getAttribute("data-history-back")) { openHistory(); return; }
    while (target && !target.getAttribute("data-session")) target = target.parentNode;
    if (!target) return;
    requestJson("GET", "/api/sessions/" + encodeURIComponent(target.getAttribute("data-session")), null, function (error, json) {
      if (error || !json.session) return;
      var messages = json.session.messages || [], html = '<button class="historyItem" data-history-back="1">Back</button>';
      for (var i = 0; i < messages.length; i += 1) html += '<div class="historyMessage"><strong>' + escapeHtml(messages[i].role || "") + '</strong><br>' + escapeHtml(messages[i].text || messages[i].content || "") + '</div>';
      liveHistoryList.innerHTML = html;
    });
  });
  for (var intentIndex = 0; intentIndex < intentBtns.length; intentIndex += 1) {
    add(intentBtns[intentIndex], "click", function (event) {
      var button = event.currentTarget || event.srcElement;
      sendInkToHermes(button && button.getAttribute ? button.getAttribute("data-intent") : "");
    });
  }
  add(closeReplyBtn, "click", hideReply);
  add(undoInkBtn, "click", undoInk);
  add(clearInkBtn, "click", requestClear);
  add(eraserInkBtn, "click", toggleEraser);
  add(copyInkBtn, "click", copyInk);
  add(pasteInkBtn, "click", pasteInk);
  add(lassoInkBtn, "click", toggleLasso);
  add(rotateInkBtn, "click", rotateSelection);
  add(deleteSelectionBtn, "click", deleteSelection);
  add(moveSelectionBtn, "click", toggleMoveSelection);
  add(askSelectionBtn, "click", function(){sendInkToHermes("");});
  add(window, "focus", function () { refreshInkFromServer(true); });
  add(window, "storage", function (event) {
    var key = event && event.key ? String(event.key) : "";
    if (key === INK_SEND_KEY) {
      pendingInkSend = readPendingInkSend();
      updateInkButtons();
    }
    if (!key || key === INK_STORAGE_KEY || key.indexOf(INK_OP_PREFIX) === 0) {
      if (!event || event.newValue !== null) rematerializeInk();
      refreshInkFromServer(true);
    }
  });
  add(document, "visibilitychange", function () {
    if (typeof document.hidden === "undefined" || !document.hidden) refreshInkFromServer(true);
  });
  add(backBtn, "click", function () {
    openHistory();
  });

  loadInk();
  setText(liveThemeBtn, darkMode ? "Light" : "Dark");
  setToolsOpen(false);
  resizeCanvas();
  loadMetadata(true);
  refreshInkFromServer(true);
}());
