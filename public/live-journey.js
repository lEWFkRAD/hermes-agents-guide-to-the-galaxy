(function () {
  var toolbar = document.getElementById("annotationTools");
  var liveShell = document.querySelector ? document.querySelector(".liveShell") : null;
  if (!toolbar || !liveShell) return;

  var authTok = "";
  var remoteKey = "";
  var darkMode = false;
  var frames = [];
  var historyTrimmed = false;
  var totalSteps = 0;
  var currentStep = -1;
  var currentFrameIndex = -1;
  var activeFrameState = null;
  var frameGeneration = 0;
  var frameLoaded = false;
  var playing = false;
  var playbackTimer = null;
  var request = null;
  var lastFocus = null;
  var TICK_MS = 83;
  var LEGACY_POINT_MS = 32;
  var MAX_POINT_T = 600000;
  var MAX_FRAMES = 120;
  var MAX_TOTAL_POINTS = 30000;

  function add(element, name, handler) {
    if (!element) return;
    if (element.addEventListener) element.addEventListener(name, handler, false);
    else if (element.attachEvent) element.attachEvent("on" + name, handler);
  }

  function setText(element, value) {
    if (!element) return;
    var text = value == null ? "" : String(value);
    if (typeof element.textContent !== "undefined") element.textContent = text;
    else element.innerText = text;
  }

  function readAccessAndTheme() {
    var search = window.location.search || "";
    var authMatch = search.match(/[?&]k=([^&#]+)/);
    var remoteQuery = search.match(/[?&]rk=([^&#]+)/);
    var remotePath = (window.location.pathname || "").match(/^\/remote\/([^/]+)\/live\/?$/);
    if (remoteQuery) remoteKey = decodeURIComponent(remoteQuery[1]);
    else if (remotePath) remoteKey = decodeURIComponent(remotePath[1]);
    try {
      if (authMatch) authTok = decodeURIComponent(authMatch[1]);
      else authTok = window.localStorage.getItem("diaryAuth") || "";
      darkMode = /(?:^|[?&])theme=dark(?:&|$)/.test(search) || window.localStorage.getItem("diaryDark") === "1";
    } catch (error) {
      darkMode = /(?:^|[?&])theme=dark(?:&|$)/.test(search);
    }
  }

  function setAuth(xhr) {
    if (authTok) {
      try { xhr.setRequestHeader("x-diary-auth", authTok); } catch (error) {}
    }
    if (remoteKey) {
      try { xhr.setRequestHeader("x-diary-remote-key", remoteKey); } catch (error) {}
    }
  }

  readAccessAndTheme();

  var journeyBtn = document.createElement("button");
  journeyBtn.id = "journeyBtn";
  journeyBtn.type = "button";
  journeyBtn.setAttribute("aria-haspopup", "dialog");
  journeyBtn.setAttribute("aria-controls", "journeyOverlay");
  setText(journeyBtn, "Journey");
  var backBtn = document.getElementById("backBtn");
  if (backBtn && backBtn.parentNode) backBtn.parentNode.insertBefore(journeyBtn, backBtn);
  else toolbar.appendChild(journeyBtn);

  var overlay = document.createElement("section");
  overlay.id = "journeyOverlay";
  overlay.className = "journeyOverlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-labelledby", "journeyTitle");
  overlay.setAttribute("hidden", "hidden");
  overlay.innerHTML = [
    '<header class="journeyBar">',
      '<div class="journeyHeading">',
        '<strong id="journeyTitle">Journey</strong>',
        '<span id="journeyMeta">Loading history…</span>',
      '</div>',
      '<button id="journeyNowBtn" type="button" aria-label="Exit Journey and return to the live page">Now</button>',
    '</header>',
    '<div id="journeyStage" class="journeyStage">',
      '<div id="journeyViewport" class="journeyViewport">',
        '<iframe id="journeyFrame" title="Journey page" sandbox="" referrerpolicy="no-referrer"></iframe>',
        '<svg id="journeyInk" aria-hidden="true" focusable="false"></svg>',
      '</div>',
      '<div id="journeyMessage" class="journeyMessage" aria-live="polite">Loading history…</div>',
    '</div>',
    '<footer class="journeyControls">',
      '<div class="journeyTransport" role="toolbar" aria-label="Journey playback">',
        '<button id="journeyPrevBtn" type="button">Prev</button>',
        '<button id="journeyPlayBtn" type="button">Play</button>',
        '<button id="journeyNextBtn" type="button">Next</button>',
      '</div>',
      '<div class="journeyProgressRow">',
        '<input id="journeyProgress" type="range" min="0" max="0" value="0" step="1" aria-label="Journey progress">',
        '<output id="journeyProgressText" for="journeyProgress">0 / 0</output>',
      '</div>',
    '</footer>'
  ].join("");
  liveShell.appendChild(overlay);

  var nowBtn = document.getElementById("journeyNowBtn");
  var frameEl = document.getElementById("journeyFrame");
  var inkEl = document.getElementById("journeyInk");
  var stageEl = document.getElementById("journeyStage");
  var viewportEl = document.getElementById("journeyViewport");
  var messageEl = document.getElementById("journeyMessage");
  var metaEl = document.getElementById("journeyMeta");
  var prevBtn = document.getElementById("journeyPrevBtn");
  var playBtn = document.getElementById("journeyPlayBtn");
  var nextBtn = document.getElementById("journeyNextBtn");
  var progressEl = document.getElementById("journeyProgress");
  var progressTextEl = document.getElementById("journeyProgressText");
  var SVG_NS = "http://www.w3.org/2000/svg";

  function isOpen() {
    return !overlay.hasAttribute("hidden");
  }

  function showMessage(text) {
    setText(messageEl, text);
    messageEl.className = "journeyMessage";
  }

  function hideMessage() {
    messageEl.className = "journeyMessage hidden";
  }

  function normalizePoint(raw) {
    var x = Number(raw && raw.x);
    var y = Number(raw && raw.y);
    if (!isFinite(x) || !isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) return null;
    var point = { x: x, y: y };
    var t = Number(raw && raw.t);
    if (isFinite(t) && t >= 0 && t <= MAX_POINT_T) point.t = Math.round(t);
    return point;
  }

  function normalizeStroke(raw, fallbackIndex, pointLimit) {
    if (!raw || typeof raw !== "object") return null;
    var source = Object.prototype.toString.call(raw.points) === "[object Array]" ? raw.points : [];
    var points = [];
    var limit = Math.max(1, Math.min(1200, Number(pointLimit) || 1200));
    for (var i = 0; i < source.length && points.length < limit; i += 1) {
      var point = normalizePoint(source[i]);
      if (point) points.push(point);
    }
    if (!points.length) return null;
    var createdAt = Number(raw.createdAt);
    var order = Number(raw.order);
    var surfaceWidth = Number(raw.surfaceWidth);
    var surfaceHeight = Number(raw.surfaceHeight);
    return {
      id: String(raw.id || "journey-stroke-" + fallbackIndex),
      createdAt: isFinite(createdAt) && createdAt >= 0 ? createdAt : fallbackIndex,
      order: isFinite(order) && order >= 0 ? order : 0,
      surfaceWidth: isFinite(surfaceWidth) && surfaceWidth > 0 ? Math.round(surfaceWidth) : 0,
      surfaceHeight: isFinite(surfaceHeight) && surfaceHeight > 0 ? Math.round(surfaceHeight) : 0,
      points: points
    };
  }

  function normalizeFrames(result) {
    var source = Object.prototype.toString.call(result) === "[object Array]" ? result : result && result.frames;
    if (Object.prototype.toString.call(source) !== "[object Array]") return [];
    var normalized = [];
    var remainingPoints = MAX_TOTAL_POINTS;
    historyTrimmed = Boolean(result && result.truncated);
    var start = Math.max(0, source.length - MAX_FRAMES);
    if (start > 0) historyTrimmed = true;
    for (var i = source.length - 1; i >= start; i -= 1) {
      var raw = source[i] || {};
      var page = raw.page || {};
      var revision = String(page.revision || "");
      if (!revision || revision.length > 180) continue;
      var rawStrokes = Object.prototype.toString.call(raw.strokes) === "[object Array]" ? raw.strokes : [];
      if (raw.inkTrimmed) historyTrimmed = true;
      var strokes = [];
      var strokeStart = Math.max(0, rawStrokes.length - 500);
      if (strokeStart > 0) historyTrimmed = true;
      for (var s = rawStrokes.length - 1; s >= strokeStart; s -= 1) {
        if (remainingPoints < 1) {
          if (s >= 0) historyTrimmed = true;
          break;
        }
        var rawPoints = rawStrokes[s] && rawStrokes[s].points;
        var rawPointCount = Object.prototype.toString.call(rawPoints) === "[object Array]" ? rawPoints.length : 0;
        var stroke = normalizeStroke(rawStrokes[s], s, 1200);
        if (stroke) {
          if (rawPointCount > stroke.points.length) historyTrimmed = true;
          if (stroke.points.length > remainingPoints) {
            historyTrimmed = true;
            remainingPoints = 0;
            break;
          }
          remainingPoints -= stroke.points.length;
          strokes.push(stroke);
        }
      }
      strokes.sort(function (left, right) {
        var orderDifference = Number(left.order || 0) - Number(right.order || 0);
        if (orderDifference) return orderDifference;
        var timeDifference = Number(left.createdAt || 0) - Number(right.createdAt || 0);
        if (timeDifference) return timeDifference;
        return String(left.id).localeCompare(String(right.id));
      });
      normalized.unshift({
        page: {
          title: String(page.title || "HTML").slice(0, 240),
          revision: revision,
          updatedAt: String(page.updatedAt || "").slice(0, 80)
        },
        strokes: strokes,
        stepStart: 0,
        stepCount: 1
      });
    }
    return normalized;
  }
  function buildTimeline() {
    totalSteps = 0;
    for (var i = 0; i < frames.length; i += 1) {
      frames[i].stepStart = totalSteps;
      frames[i].stepCount = 1;
      for (var s = 0; s < frames[i].strokes.length; s += 1) {
        frames[i].stepCount += frames[i].strokes[s].points.length;
      }
      totalSteps += frames[i].stepCount;
    }
    progressEl.min = "0";
    progressEl.max = String(Math.max(0, totalSteps - 1));
  }

  function locateStep(index) {
    if (!frames.length || totalSteps < 1) return null;
    var step = Math.max(0, Math.min(totalSteps - 1, Math.round(Number(index) || 0)));
    var frameIndex = 0;
    for (var i = 0; i < frames.length; i += 1) {
      if (step >= frames[i].stepStart && step < frames[i].stepStart + frames[i].stepCount) {
        frameIndex = i;
        break;
      }
    }
    var frame = frames[frameIndex];
    var offset = step - frame.stepStart;
    if (offset === 0) return { step: step, frameIndex: frameIndex, strokeIndex: -1, pointCount: 0 };
    offset -= 1;
    for (var s = 0; s < frame.strokes.length; s += 1) {
      var length = frame.strokes[s].points.length;
      if (offset < length) return { step: step, frameIndex: frameIndex, strokeIndex: s, pointCount: offset + 1 };
      offset -= length;
    }
    return { step: step, frameIndex: frameIndex, strokeIndex: frame.strokes.length - 1, pointCount: frame.strokes.length ? frame.strokes[frame.strokes.length - 1].points.length : 0 };
  }

  function smoothedJourneyPoints(points) {
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

  function pointPathData(points, count, width, height) {
    var limit = Math.max(0, Math.min(points.length, count));
    if (!limit) return "";
    points = smoothedJourneyPoints(points.slice(0, limit));
    limit = points.length;
    var path = ["M", points[0].x * width, points[0].y * height];
    if (limit === 1) return path.join(" ");
    if (limit === 2) {
      path.push("L", points[1].x * width, points[1].y * height);
      return path.join(" ");
    }
    for (var i = 1; i < limit - 1; i += 1) {
      var point = points[i];
      var next = points[i + 1];
      path.push("Q", point.x * width, point.y * height, ((point.x + next.x) / 2) * width, ((point.y + next.y) / 2) * height);
    }
    var last = points[limit - 1];
    path.push("L", last.x * width, last.y * height);
    return path.join(" ");
  }

  function drawStroke(stroke, pointCount, width, height) {
    var count = Math.max(0, Math.min(stroke.points.length, pointCount));
    if (!count) return;
    var element;
    if (count === 1) {
      element = document.createElementNS(SVG_NS, "circle");
      element.setAttribute("cx", stroke.points[0].x * width);
      element.setAttribute("cy", stroke.points[0].y * height);
      element.setAttribute("r", "1.8");
      element.setAttribute("fill", darkMode ? "#f2efe7" : "#171612");
    } else {
      element = document.createElementNS(SVG_NS, "path");
      element.setAttribute("d", pointPathData(stroke.points, count, width, height));
      element.setAttribute("fill", "none");
      element.setAttribute("stroke", darkMode ? "#f2efe7" : "#171612");
      element.setAttribute("stroke-width", "3");
      element.setAttribute("stroke-linecap", "round");
      element.setAttribute("stroke-linejoin", "round");
    }
    inkEl.appendChild(element);
  }

  function frameViewportSize(frame, fallbackWidth, fallbackHeight) {
    var sizes = {};
    var winner = null;
    var frameStrokes = frame && frame.strokes ? frame.strokes : [];
    for (var i = 0; i < frameStrokes.length; i += 1) {
      var width = Number(frameStrokes[i].surfaceWidth);
      var height = Number(frameStrokes[i].surfaceHeight);
      if (!isFinite(width) || !isFinite(height) || width < 1 || height < 1) continue;
      var key = Math.round(width) + "x" + Math.round(height);
      if (!sizes[key]) sizes[key] = { width: Math.round(width), height: Math.round(height), weight: 0 };
      sizes[key].weight += Math.max(1, frameStrokes[i].points.length);
      if (!winner || sizes[key].weight > winner.weight) winner = sizes[key];
    }
    return winner || {
      width: Math.max(1, Math.round(fallbackWidth)),
      height: Math.max(1, Math.round(fallbackHeight))
    };
  }

  function layoutJourneyViewport(frame) {
    var rect = stageEl.getBoundingClientRect();
    var stageWidth = Math.max(1, Math.round(rect.width));
    var stageHeight = Math.max(1, Math.round(rect.height));
    var size = frameViewportSize(frame, stageWidth, stageHeight);
    var scale = Math.min(stageWidth / size.width, stageHeight / size.height);
    if (!isFinite(scale) || scale <= 0) scale = 1;
    var left = Math.max(0, (stageWidth - (size.width * scale)) / 2);
    var top = Math.max(0, (stageHeight - (size.height * scale)) / 2);
    viewportEl.style.width = size.width + "px";
    viewportEl.style.height = size.height + "px";
    viewportEl.style.transform = "translate(" + left + "px," + top + "px) scale(" + scale + ")";
    inkEl.setAttribute("viewBox", "0 0 " + size.width + " " + size.height);
    inkEl.setAttribute("preserveAspectRatio", "none");
    return size;
  }

  function redrawInk(state) {
    while (inkEl.firstChild) inkEl.removeChild(inkEl.firstChild);
    var frame = state ? frames[state.frameIndex] : null;
    var size = layoutJourneyViewport(frame);
    var width = size.width;
    var height = size.height;
    if (!state || state.strokeIndex < 0) return;
    for (var i = 0; i < state.strokeIndex; i += 1) {
      drawStroke(frame.strokes[i], frame.strokes[i].points.length, width, height);
    }
    drawStroke(frame.strokes[state.strokeIndex], state.pointCount, width, height);
  }

  function contentUrl(revision) {
    var values = [];
    if (remoteKey) values.push("rk=" + encodeURIComponent(remoteKey));
    else if (authTok) values.push("k=" + encodeURIComponent(authTok));
    values.push("revision=" + encodeURIComponent(revision));
    values.push("theme=" + (darkMode ? "dark" : "light"));
    return "/api/live-page/journey/content?" + values.join("&");
  }

  function formatDate(value) {
    if (!value) return "";
    try { return (new Date(value)).toLocaleString(); } catch (error) { return ""; }
  }

  function updateControls(state) {
    var frame = state ? frames[state.frameIndex] : null;
    var frameNumber = state ? state.frameIndex + 1 : 0;
    var strokeNumber = state && state.strokeIndex >= 0 ? state.strokeIndex + 1 : 0;
    var strokeTotal = frame ? frame.strokes.length : 0;
    var detail = frameNumber + " / " + frames.length;
    if (strokeTotal) detail += " · ink " + strokeNumber + " / " + strokeTotal;
    setText(progressTextEl, detail);
    progressEl.value = String(Math.max(0, currentStep));
    progressEl.setAttribute("aria-valuetext", detail);
    prevBtn.disabled = currentStep <= 0;
    nextBtn.disabled = currentStep < 0 || currentStep >= totalSteps - 1;
    playBtn.disabled = totalSteps <= 1;
    setText(playBtn, playing ? "Pause" : "Play");
    playBtn.setAttribute("aria-pressed", playing ? "true" : "false");
    if (frame) {
      var date = formatDate(frame.page.updatedAt);
      setText(metaEl, frame.page.title + (date ? " · " + date : "") + (historyTrimmed ? " · recent history" : ""));
    }
  }

  function openJourneyFrame(frame, state) {
    frameGeneration += 1;
    var generation = frameGeneration;
    frameLoaded = false;
    activeFrameState = state;
    while (inkEl.firstChild) inkEl.removeChild(inkEl.firstChild);
    layoutJourneyViewport(frame);
    showMessage("Opening " + frame.page.title + "…");
    var nextFrame = document.createElement("iframe");
    nextFrame.id = "journeyFrame";
    nextFrame.title = frame.page.title + " journey page";
    nextFrame.setAttribute("sandbox", "");
    nextFrame.setAttribute("referrerpolicy", "no-referrer");
    viewportEl.replaceChild(nextFrame, frameEl);
    frameEl = nextFrame;
    add(nextFrame, "load", function () {
      if (!isOpen() || generation !== frameGeneration || nextFrame !== frameEl) return;
      frameLoaded = true;
      hideMessage();
      redrawInk(activeFrameState);
    });
    nextFrame.src = contentUrl(frame.page.revision);
  }

  function showStep(index) {
    var state = locateStep(index);
    if (!state) return;
    var frameChanged = currentFrameIndex !== state.frameIndex;
    currentStep = state.step;
    currentFrameIndex = state.frameIndex;
    activeFrameState = state;
    var frame = frames[state.frameIndex];
    if (frameChanged) openJourneyFrame(frame, state);
    else if (frameLoaded) redrawInk(state);
    updateControls(state);
  }
  function pointTime(stroke, pointIndex) {
    var point = stroke.points[pointIndex];
    if (point && typeof point.t === "number" && isFinite(point.t)) return point.t;
    return pointIndex * LEGACY_POINT_MS;
  }

  function nextPlaybackStep() {
    var state = locateStep(currentStep);
    if (!state || currentStep >= totalSteps - 1) return totalSteps - 1;
    if (state.strokeIndex < 0) return currentStep + 1;
    var stroke = frames[state.frameIndex].strokes[state.strokeIndex];
    if (state.pointCount >= stroke.points.length) return currentStep + 1;
    var currentPointIndex = state.pointCount - 1;
    var targetTime = pointTime(stroke, currentPointIndex) + TICK_MS;
    var nextCount = state.pointCount + 1;
    while (nextCount < stroke.points.length && pointTime(stroke, nextCount - 1) < targetTime) nextCount += 1;
    return Math.min(totalSteps - 1, currentStep + (nextCount - state.pointCount));
  }

  function playbackDelay(nextStep) {
    var current = locateStep(currentStep);
    var next = locateStep(nextStep);
    if (!current || !next) return TICK_MS;
    if (current.frameIndex !== next.frameIndex) return 900;
    if (current.strokeIndex !== next.strokeIndex || current.strokeIndex < 0) return 220;
    return TICK_MS;
  }

  function stopPlayback() {
    playing = false;
    if (playbackTimer) window.clearTimeout(playbackTimer);
    playbackTimer = null;
    updateControls(locateStep(currentStep));
  }

  function schedulePlayback() {
    if (!playing) return;
    if (currentStep >= totalSteps - 1) {
      stopPlayback();
      return;
    }
    var nextStep = nextPlaybackStep();
    var delay = playbackDelay(nextStep);
    playbackTimer = window.setTimeout(function () {
      if (!playing) return;
      showStep(nextStep);
      schedulePlayback();
    }, delay);
  }

  function togglePlayback() {
    if (playing) {
      stopPlayback();
      return;
    }
    if (totalSteps <= 1) return;
    if (currentStep >= totalSteps - 1) showStep(0);
    playing = true;
    updateControls(locateStep(currentStep));
    schedulePlayback();
  }

  function closePalette() {
    var toggle = document.getElementById("annotationToggleBtn");
    if (toggle && toggle.getAttribute("aria-expanded") === "true") {
      try { toggle.click(); } catch (error) {}
    }
  }

  function closeJourney() {
    stopPlayback();
    if (request) {
      try { request.abort(); } catch (error) {}
      request = null;
    }
    overlay.setAttribute("hidden", "hidden");
    overlay.setAttribute("aria-busy", "false");
    frameGeneration += 1;
    frameLoaded = false;
    activeFrameState = null;
    frameEl.src = "about:blank";
    while (inkEl.firstChild) inkEl.removeChild(inkEl.firstChild);
    if (lastFocus && lastFocus.focus) {
      try { lastFocus.focus(); } catch (error) {}
    }
  }

  function loadJourney() {
    showMessage("Loading history…");
    setText(metaEl, "Loading history…");
    overlay.setAttribute("aria-busy", "true");
    prevBtn.disabled = true;
    playBtn.disabled = true;
    nextBtn.disabled = true;
    progressEl.disabled = true;
    var xhr = new XMLHttpRequest();
    request = xhr;
    xhr.open("GET", "/api/live-page/journey", true);
    xhr.setRequestHeader("accept", "application/json");
    setAuth(xhr);
    xhr.timeout = 20000;
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4 || request !== xhr) return;
      request = null;
      if (xhr.status < 200 || xhr.status >= 300) {
        overlay.setAttribute("aria-busy", "false");
        showMessage(xhr.status === 404 ? "No Journey history is available yet." : "Journey could not be loaded.");
        setText(metaEl, "History unavailable");
        return;
      }
      try {
        var result = JSON.parse(xhr.responseText);
        frames = normalizeFrames(result);
        buildTimeline();
        overlay.setAttribute("aria-busy", "false");
        progressEl.disabled = !frames.length;
        if (!frames.length) {
          showMessage("No Journey history is available yet.");
          setText(metaEl, "No archived versions");
          updateControls(null);
          return;
        }
        showStep(totalSteps - 1);
      } catch (error) {
        overlay.setAttribute("aria-busy", "false");
        showMessage("Journey history could not be read.");
        setText(metaEl, "Unreadable history");
      }
    };
    xhr.onerror = function () {
      if (request !== xhr) return;
      request = null;
      overlay.setAttribute("aria-busy", "false");
      showMessage("Journey could not be loaded.");
      setText(metaEl, "History unavailable");
    };
    xhr.ontimeout = xhr.onerror;
    xhr.send(null);
  }

  function openJourney() {
    if (isOpen()) return;
    lastFocus = document.activeElement;
    closePalette();
    overlay.removeAttribute("hidden");
    frames = [];
    historyTrimmed = false;
    totalSteps = 0;
    currentStep = -1;
    currentFrameIndex = -1;
    progressEl.value = "0";
    setText(progressTextEl, "0 / 0");
    loadJourney();
    if (nowBtn.focus) {
      try { nowBtn.focus(); } catch (error) {}
    }
  }

  add(journeyBtn, "click", openJourney);
  add(nowBtn, "click", closeJourney);
  add(playBtn, "click", togglePlayback);
  add(prevBtn, "click", function () {
    stopPlayback();
    if (currentStep > 0) showStep(currentStep - 1);
  });
  add(nextBtn, "click", function () {
    stopPlayback();
    if (currentStep >= 0 && currentStep < totalSteps - 1) showStep(currentStep + 1);
  });
  function scrubJourney() {
    stopPlayback();
    showStep(Math.round(Number(progressEl.value) || 0));
  }
  add(progressEl, "input", scrubJourney);
  add(progressEl, "change", scrubJourney);

  add(window, "resize", function () {
    if (isOpen() && currentStep >= 0) {
      layoutJourneyViewport(frames[currentFrameIndex]);
      redrawInk(locateStep(currentStep));
    }
  });
  add(document, "keydown", function (event) {
    var key = event && (event.key || event.keyCode);
    if (isOpen() && (key === "Escape" || key === "Esc" || key === 27)) closeJourney();
  });
}());
