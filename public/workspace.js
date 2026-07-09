(function () {
  var authTok = "";
  try {
    var match = (window.location.search || "").match(/[?&]k=([^&#]+)/);
    authTok = match ? decodeURIComponent(match[1]) : (window.localStorage.getItem("diaryAuth") || "");
  } catch (e) {}

  var fileEl = document.getElementById("artifactFile");
  var modeEl = document.getElementById("workspaceMode");
  var newBtn = document.getElementById("newWorkspaceBtn");
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

  function request(method, url, body) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open(method, url, true);
      xhr.setRequestHeader("content-type", "application/json");
      if (authTok) xhr.setRequestHeader("x-diary-auth", authTok);
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
    ctx.strokeStyle = "#b3271e";
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (var i = 0; i < strokes.length; i += 1) drawStroke(strokes[i]);
  }

  function drawStroke(stroke) {
    if (!stroke.points.length) return;
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
    return false;
  }

  function startInk(event) {
    current = { id: "stroke_" + Date.now().toString(36), width: 3, points: [point(event)] };
    strokes.push(current);
    drawing = true;
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
    drawing = false;
    current = null;
    return stop(event);
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
    var src = artifact.contentUrl + (authTok ? ("?k=" + encodeURIComponent(authTok)) : "");
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
  clearAnnotationBtn.addEventListener("click", clearInk, false);
  saveAnnotationBtn.addEventListener("click", saveAnnotation, false);
  analyzeBtn.addEventListener("click", analyze, false);
  canvas.addEventListener("pointerdown", startInk, false);
  canvas.addEventListener("pointermove", moveInk, false);
  canvas.addEventListener("pointerup", endInk, false);
  canvas.addEventListener("pointercancel", endInk, false);
  canvas.addEventListener("touchstart", startInk, false);
  canvas.addEventListener("touchmove", moveInk, false);
  canvas.addEventListener("touchend", endInk, false);
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
          showArtifact();
          setStatus("Workspace restored. Draw a new annotation or continue the review.");
        } else {
          setStatus("Workspace restored. Choose an artifact.");
        }
      }).catch(function () {
        try { window.localStorage.removeItem("artifactWorkspaceId"); } catch (e) {}
        try { window.localStorage.removeItem("artifactActiveId"); } catch (e) {}
      });
    }
  } catch (e) {}
}());
