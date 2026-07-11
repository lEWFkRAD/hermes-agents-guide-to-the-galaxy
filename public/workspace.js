(function () {
  var authTok = "";
  var remoteKey = "";
  try {
    var match = (window.location.search || "").match(/[?&]k=([^&#]+)/);
    var remoteMatch = (window.location.search || "").match(/[?&]rk=([^&#]+)/);
    var remotePathMatch = (window.location.pathname || "").match(/^\/remote\/([^/]+)\/?$/);
    if (remoteMatch) remoteKey = decodeURIComponent(remoteMatch[1]);
    else if (remotePathMatch) remoteKey = decodeURIComponent(remotePathMatch[1]);
    authTok = match ? decodeURIComponent(match[1]) : (window.localStorage.getItem("diaryAuth") || "");
  } catch (e) {}

  var fileEl = document.getElementById("artifactFile");
  var modeEl = document.getElementById("workspaceMode");
  var newBtn = document.getElementById("newWorkspaceBtn");
  var workspaceLab = document.getElementById("workspaceLab");
  var brainstormIdeas = document.getElementById("brainstormIdeas");
  var statusEl = document.getElementById("workspaceStatus");
  var workbench = document.getElementById("artifactWorkbench");
  var surface = document.getElementById("artifactSurface");
  var frame = document.getElementById("artifactFrame");
  var image = document.getElementById("artifactImage");
  var canvas = document.getElementById("annotationInk");
  var artifactName = document.getElementById("artifactName");
  var artifactRevision = document.getElementById("artifactRevision");
  var intentEl = document.getElementById("annotationIntent");
  var annotationText = document.getElementById("annotationText");
  var saveAnnotationBtn = document.getElementById("saveAnnotationBtn");
  var clearAnnotationBtn = document.getElementById("clearAnnotationBtn");
  var instructionEl = document.getElementById("proposalInstruction");
  var analyzeBtn = document.getElementById("analyzeArtifactBtn");
  var review = document.getElementById("proposalReview");
  var proposalSummary = document.getElementById("proposalSummary");
  var proposalChanges = document.getElementById("proposalChanges");
  if (!fileEl || !canvas) return;

  var ctx = canvas.getContext("2d");
  var workspace = null;
  var artifact = null;
  var strokes = [];
  var current = null;
  var drawing = false;

  function escapeHtml(value) {
    return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function setStatus(text) {
    statusEl.textContent = text;
  }

  function isDark() {
    if ((" " + document.body.className + " ").indexOf(" dark ") >= 0) return true;
    try { return window.localStorage.getItem("diaryDark") === "1"; } catch (e) { return false; }
  }

  function brainstormDocument(kind) {
    var dark = isDark();
    var paper = dark ? "#15140f" : "#fbfaf4";
    var ink = dark ? "#e9e7e0" : "#111111";
    var faint = dark ? "#5b574d" : "#b9b2a4";
    var shapes = "";

    if (kind === "map") {
      shapes = '<div class="map lines"><i></i><i></i><i></i><i></i></div>' +
        '<div class="node center"></div><div class="node northWest"></div>' +
        '<div class="node northEast"></div><div class="node southWest"></div>' +
        '<div class="node southEast"></div>';
    } else if (kind === "path") {
      shapes = '<div class="pathLine"></div><div class="pathBox one"></div>' +
        '<div class="pathBox two"></div><div class="pathBox three"></div>';
    } else if (kind === "grid") {
      shapes = '<div class="fourGrid"><div></div><div></div><div></div><div></div></div>';
    }

    return '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<title>Brainstorm</title><style>' +
      '*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden}' +
      'body{position:relative;background:' + paper + ';color:' + ink + ';font-family:Georgia,serif}' +
      '.node,.pathBox,.fourGrid>div{position:absolute;border:2px solid ' + faint + ';background:' + paper + '}' +
      '.node{width:16%;height:16%;min-width:62px;min-height:62px;border-radius:50%}' +
      '.center{left:42%;top:42%}.northWest{left:12%;top:12%}.northEast{right:12%;top:12%}' +
      '.southWest{left:12%;bottom:12%}.southEast{right:12%;bottom:12%}' +
      '.lines i{position:absolute;left:25%;top:50%;width:50%;border-top:2px solid ' + faint + ';transform-origin:center}' +
      '.lines i:nth-child(1){transform:rotate(32deg)}.lines i:nth-child(2){transform:rotate(-32deg)}' +
      '.lines i:nth-child(3){transform:rotate(148deg)}.lines i:nth-child(4){transform:rotate(-148deg)}' +
      '.pathLine{position:absolute;left:15%;right:15%;top:50%;border-top:2px solid ' + faint + '}' +
      '.pathBox{top:39%;width:20%;height:22%;border-radius:10px}.pathBox.one{left:7%}' +
      '.pathBox.two{left:40%}.pathBox.three{right:7%}' +
      '.fourGrid{position:absolute;inset:8%;display:grid;grid-template-columns:1fr 1fr;gap:5%}' +
      '.fourGrid>div{position:static;min-height:0}' +
      '</style></head><body>' + shapes + '</body></html>';
  }

  function templateLabel(kind) {
    return { blank: "Blank", map: "Map", path: "Path", grid: "Grid" }[kind] || "Blank";
  }

  function showBrainstormChoices(show) {
    if (!brainstormIdeas) return;
    brainstormIdeas.hidden = !show;
    if (workspaceLab) {
      if (show) workspaceLab.classList.add("brainstormMode");
      else workspaceLab.classList.remove("brainstormMode");
    }
  }

  function startBrainstorm(kind) {
    var label = templateLabel(kind);
    workspace = null;
    artifact = null;
    strokes = [];
    workbench.hidden = true;
    fileEl.value = "";
    showBrainstormChoices(false);
    newBtn.disabled = true;
    setStatus("Opening " + label.toLowerCase() + " page…");

    request("POST", "/api/workspaces", {
      title: label + " brainstorm",
      mode: "brainstorm"
    }).then(function (result) {
      workspace = result.workspace;
      return request("POST", "/api/workspaces/" + workspace.id + "/artifacts", {
        type: "html",
        name: label,
        content: brainstormDocument(kind)
      });
    }).then(function (result) {
      workspace = result.workspace;
      artifact = result.artifact;
      try { window.localStorage.setItem("artifactWorkspaceId", workspace.id); } catch (e) {}
      try { window.localStorage.setItem("artifactActiveId", artifact.id); } catch (e) {}
      showArtifact();
      setStatus(label + " ready. Draw anywhere.");
      newBtn.disabled = false;
      window.setTimeout(function () {
        if (workbench.scrollIntoView) workbench.scrollIntoView(true);
      }, 40);
    }).catch(function (error) {
      showBrainstormChoices(true);
      newBtn.disabled = false;
      setStatus(error.message);
    });
  }

  function request(method, url, body) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open(method, url, true);
      xhr.setRequestHeader("content-type", "application/json");
      if (authTok) xhr.setRequestHeader("x-diary-auth", authTok);
      if (remoteKey) xhr.setRequestHeader("x-diary-remote-key", remoteKey);
      xhr.onreadystatechange = function () {
        if (xhr.readyState !== 4) return;
        var json;
        try { json = JSON.parse(xhr.responseText); } catch (e) { json = null; }
        if (xhr.status < 200 || xhr.status >= 300) {
          reject(new Error((json && json.error) || ("HTTP " + xhr.status)));
        } else resolve(json);
      };
      xhr.onerror = function () { reject(new Error("Network error")); };
      xhr.send(body === undefined ? null : JSON.stringify(body));
    });
  }

  function resizeCanvas() {
    var rect = surface.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(rect.width));
    canvas.height = Math.max(1, Math.round(rect.height));
    redraw();
  }

  function redraw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = isDark() ? "#f2efe7" : "#171612";
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (var i = 0; i < strokes.length; i += 1) drawStroke(strokes[i]);
  }

  function drawStroke(stroke) {
    if (!stroke.points.length) return;
    if (stroke.points.length === 1) {
      ctx.beginPath();
      ctx.arc(stroke.points[0].x * canvas.width, stroke.points[0].y * canvas.height, 1.8, 0, Math.PI * 2);
      ctx.fillStyle = isDark() ? "#f2efe7" : "#171612";
      ctx.fill();
      return;
    }
    ctx.beginPath();
    ctx.moveTo(stroke.points[0].x * canvas.width, stroke.points[0].y * canvas.height);
    for (var i = 1; i < stroke.points.length; i += 1) {
      ctx.lineTo(stroke.points[i].x * canvas.width, stroke.points[i].y * canvas.height);
    }
    ctx.stroke();
  }

  function point(event) {
    var rect = canvas.getBoundingClientRect();
    var source = event.touches && event.touches[0] ? event.touches[0] : event;
    return {
      x: Math.max(0, Math.min(1, (source.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (source.clientY - rect.top) / rect.height)),
      t: Date.now()
    };
  }

  function stop(event) {
    if (event.preventDefault) event.preventDefault();
    if (event.stopPropagation) event.stopPropagation();
    event.returnValue = false;
    return false;
  }

  function startInk(event) {
    if (event.pointerId !== undefined && surface.setPointerCapture) {
      try { surface.setPointerCapture(event.pointerId); } catch (e) {}
    }
    current = { id: "stroke_" + Date.now().toString(36), width: 3, points: [point(event)] };
    strokes.push(current);
    drawing = true;
    redraw();
    return stop(event);
  }

  function moveInk(event) {
    if (!drawing || !current) return stop(event);
    var p = point(event);
    var previous = current.points[current.points.length - 1];
    if (Math.abs(p.x - previous.x) + Math.abs(p.y - previous.y) > 0.0015) {
      current.points.push(p);
      redraw();
    }
    return stop(event);
  }

  function endInk(event) {
    redraw();
    drawing = false;
    current = null;
    return stop(event);
  }

  function addEvent(element, name, handler) {
    if (!element) return;
    if (element.addEventListener) element.addEventListener(name, handler, false);
    else if (element.attachEvent) element.attachEvent("on" + name, handler);
  }

  function bindInkEvents(element) {
    if (window.PointerEvent) {
      addEvent(element, "pointerdown", startInk);
      addEvent(element, "pointermove", moveInk);
      addEvent(element, "pointerup", endInk);
      addEvent(element, "pointercancel", endInk);
      addEvent(element, "pointerleave", endInk);
    } else if (window.MSPointerEvent) {
      addEvent(element, "MSPointerDown", startInk);
      addEvent(element, "MSPointerMove", moveInk);
      addEvent(element, "MSPointerUp", endInk);
    } else if ("ontouchstart" in window) {
      addEvent(element, "touchstart", startInk);
      addEvent(element, "touchmove", moveInk);
      addEvent(element, "touchend", endInk);
      addEvent(element, "touchcancel", endInk);
    } else {
      addEvent(element, "mousedown", startInk);
      addEvent(element, "mousemove", moveInk);
      addEvent(element, "mouseup", endInk);
      addEvent(element, "mouseleave", endInk);
      addEvent(document, "mouseup", endInk);
    }
  }

  function ensureWorkspace() {
    if (workspace) return Promise.resolve(workspace);
    return request("POST", "/api/workspaces", {
      title: "Scribe " + modeEl.options[modeEl.selectedIndex].text + " workspace",
      mode: modeEl.value
    }).then(function (result) {
      workspace = result.workspace;
      try { window.localStorage.setItem("artifactWorkspaceId", workspace.id); } catch (e) {}
      return workspace;
    });
  }

  function readFile(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function () { reject(new Error("Could not read file")); };
      if (file.type === "text/html" || /\.html?$/i.test(file.name)) reader.readAsText(file);
      else reader.readAsDataURL(file);
    });
  }

  function importArtifact() {
    var file = fileEl.files && fileEl.files[0];
    if (!file) return;
    setStatus("Importing artifact…");
    ensureWorkspace().then(function () {
      return readFile(file);
    }).then(function (source) {
      var isHtml = file.type === "text/html" || /\.html?$/i.test(file.name);
      var payload = isHtml
        ? { type: "html", name: file.name, content: source }
        : { type: "image", name: file.name, dataUrl: source };
      return request("POST", "/api/workspaces/" + workspace.id + "/artifacts", payload);
    }).then(function (result) {
      workspace = result.workspace;
      artifact = result.artifact;
      try { window.localStorage.setItem("artifactWorkspaceId", workspace.id); } catch (e) {}
      try { window.localStorage.setItem("artifactActiveId", artifact.id); } catch (e) {}
      showArtifact();
      setStatus("Artifact ready. Draw directly over it.");
    }).catch(function (error) {
      setStatus(error.message);
    });
  }

  function showArtifact() {
    workbench.hidden = false;
    artifactName.textContent = artifact.name;
    artifactRevision.textContent = artifact.revision.slice(0, 22) + "…";
    var query = remoteKey ? ("?rk=" + encodeURIComponent(remoteKey)) :
      (authTok ? ("?k=" + encodeURIComponent(authTok)) : "");
    var src = artifact.contentUrl + query;
    frame.style.display = artifact.type === "html" ? "block" : "none";
    image.style.display = artifact.type === "image" ? "block" : "none";
    if (artifact.type === "html") frame.src = src;
    else image.src = src;
    strokes = [];
    review.hidden = true;
    window.setTimeout(resizeCanvas, 0);
  }

  function newWorkspace() {
    workspace = null;
    artifact = null;
    strokes = [];
    workbench.hidden = true;
    fileEl.value = "";
    try { window.localStorage.removeItem("artifactActiveId"); } catch (e) {}
    if (modeEl.value === "brainstorm") {
      try { window.localStorage.removeItem("artifactWorkspaceId"); } catch (e) {}
      showBrainstormChoices(true);
      setStatus("Pick a starting page.");
      return;
    }
    ensureWorkspace().then(function () {
      setStatus("New workspace ready. Choose an artifact.");
    }).catch(function (error) { setStatus(error.message); });
  }

  function saveAnnotation() {
    if (!workspace || !artifact || !strokes.length) {
      setStatus("Draw on the artifact first.");
      return Promise.resolve(null);
    }
    setStatus("Saving vector annotation…");
    return request("POST", "/api/workspaces/" + workspace.id + "/annotations", {
        artifactId: artifact.id,
        strokes: strokes,
        anchor: { kind: "viewport", x: 0, y: 0, width: 1, height: 1 },
        transcription: annotationText.value,
        intent: intentEl.value
    }).then(function (result) {
      workspace = result.workspace;
      setStatus("Annotation saved.");
      return result.annotation;
    }).catch(function (error) {
      setStatus(error.message);
      return null;
    });
  }

  function analyze() {
    if (!workspace || !artifact) return;
    analyzeBtn.disabled = true;
    saveAnnotation().then(function (annotation) {
      if (!annotation) throw new Error("Save an annotation before analyzing.");
      setStatus("Hermes is reviewing the artifact…");
      return request("POST", "/api/workspaces/" + workspace.id + "/proposals", {
        artifactId: artifact.id,
        instruction: instructionEl.value || "Review my annotation and propose exact improvements.",
        annotationIds: [annotation.id]
      });
    }).then(function (created) {
      return request("POST", "/api/workspaces/" + workspace.id + "/proposals/" + created.proposal.id + "/analyze", {});
    }).then(function (analyzed) {
      workspace = analyzed.workspace;
      renderProposal(analyzed.proposal);
      setStatus("Proposal ready for review.");
      analyzeBtn.disabled = false;
    }).catch(function (error) {
      setStatus(error.message);
      analyzeBtn.disabled = false;
    });
  }

  function renderProposal(proposal) {
    review.hidden = false;
    proposalSummary.innerHTML = "<p>" + escapeHtml(proposal.summary) + "</p>";
    proposalChanges.innerHTML = "";
    var changes = proposal.changes || [];
    for (var i = 0; i < changes.length; i += 1) {
      var item = document.createElement("li");
      item.innerHTML = "<strong>" + escapeHtml(changes[i].kind || "change") + "</strong>: " + escapeHtml(changes[i].description || "");
      proposalChanges.appendChild(item);
    }
    if (!changes.length) proposalChanges.innerHTML = "<li>No structured changes were returned; see the review summary above.</li>";
  }

  function clearInk() {
    strokes = [];
    redraw();
    annotationText.value = "";
    setStatus("Annotation canvas cleared.");
  }

  fileEl.addEventListener("change", importArtifact, false);
  newBtn.addEventListener("click", newWorkspace, false);
  modeEl.addEventListener("change", function () {
    var brainstorming = modeEl.value === "brainstorm";
    showBrainstormChoices(brainstorming);
    setStatus(brainstorming ? "Pick a starting page." : "Choose an image or HTML file to begin.");
  }, false);
  if (brainstormIdeas) brainstormIdeas.addEventListener("click", function (event) {
    var target = event.target;
    while (target && target !== brainstormIdeas && !target.getAttribute("data-brainstorm-template")) {
      target = target.parentNode;
    }
    if (!target || target === brainstormIdeas) return;
    startBrainstorm(target.getAttribute("data-brainstorm-template"));
  }, false);
  clearAnnotationBtn.addEventListener("click", clearInk, false);
  saveAnnotationBtn.addEventListener("click", saveAnnotation, false);
  analyzeBtn.addEventListener("click", analyze, false);
  bindInkEvents(surface);
  window.addEventListener("resize", resizeCanvas, false);

  // Resume the last workspace after a refresh. The bridge remains the source
  // of truth; browser storage only remembers which workspace/artifact was open.
  try {
    var savedWorkspaceId = window.localStorage.getItem("artifactWorkspaceId");
    var savedArtifactId = window.localStorage.getItem("artifactActiveId");
    if (savedWorkspaceId) {
      request("GET", "/api/workspaces/" + savedWorkspaceId).then(function (result) {
        workspace = result.workspace;
        modeEl.value = workspace.mode || "review";
        var artifacts = workspace.artifacts || [];
        for (var i = 0; i < artifacts.length; i += 1) {
          if (artifacts[i].id === savedArtifactId) artifact = artifacts[i];
        }
        if (!artifact && artifacts.length) artifact = artifacts[artifacts.length - 1];
        if (artifact) {
          showBrainstormChoices(false);
          showArtifact();
          setStatus("Workspace restored. Draw a new annotation or continue the review.");
        } else {
          if (modeEl.value === "brainstorm") {
            showBrainstormChoices(true);
            setStatus("Pick a starting page.");
          } else {
            setStatus("Workspace restored. Choose an artifact.");
          }
        }
      }).catch(function () {
        try { window.localStorage.removeItem("artifactWorkspaceId"); } catch (e) {}
        try { window.localStorage.removeItem("artifactActiveId"); } catch (e) {}
      });
    }
  } catch (e) {}
  showBrainstormChoices(false);
}());
