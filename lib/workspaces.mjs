import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

function id(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 18)}`;
}

function now() {
  return new Date().toISOString();
}

function safeName(value, fallback) {
  const name = String(value || fallback).replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_").trim();
  return (name || fallback).slice(0, 120);
}

function revision(buffer) {
  return `sha256:${crypto.createHash("sha256").update(buffer).digest("hex")}`;
}

// HTML artifacts render in a sandboxed iframe, but sanitize the stored source
// as well so exported previews cannot carry scripts or inline event handlers.
function sanitizeHtml(source) {
  return String(source || "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe\s*>/gi, "")
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s(?:href|src)\s*=\s*(["'])\s*javascript:[\s\S]*?\1/gi, "");
}

function publicWorkspace(workspace) {
  return {
    ...workspace,
    artifacts: workspace.artifacts.map(({ storagePath, ...artifact }) => artifact)
  };
}

export class WorkspaceStore {
  constructor(dataDir) {
    this.root = path.join(dataDir, "workspaces");
    this.artifactRoot = path.join(this.root, "artifacts");
    this.indexPath = path.join(this.root, "index.json");
    this.workspaces = [];
  }

  async init() {
    await fs.mkdir(this.artifactRoot, { recursive: true });
    try {
      this.workspaces = JSON.parse(await fs.readFile(this.indexPath, "utf8"));
      if (!Array.isArray(this.workspaces)) this.workspaces = [];
    } catch {
      this.workspaces = [];
    }
  }

  async save() {
    await fs.mkdir(this.root, { recursive: true });
    const temp = `${this.indexPath}.tmp`;
    await fs.writeFile(temp, JSON.stringify(this.workspaces, null, 2));
    await fs.rename(temp, this.indexPath);
  }

  list() {
    return this.workspaces.map(workspace => ({
      id: workspace.id,
      title: workspace.title,
      mode: workspace.mode,
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
      artifactCount: workspace.artifacts.length,
      annotationCount: workspace.annotations.length,
      proposalCount: workspace.proposals.length
    }));
  }

  get(workspaceId) {
    const workspace = this.workspaces.find(item => item.id === workspaceId);
    return workspace ? publicWorkspace(workspace) : null;
  }

  raw(workspaceId) {
    return this.workspaces.find(item => item.id === workspaceId) || null;
  }

  async create({ title, mode = "review" } = {}) {
    const timestamp = now();
    const workspace = {
      id: id("ws"),
      title: safeName(title, "Untitled workspace"),
      mode: ["review", "meeting", "brainstorm", "design"].includes(mode) ? mode : "review",
      createdAt: timestamp,
      updatedAt: timestamp,
      artifacts: [],
      annotations: [],
      proposals: [],
      events: [{ id: id("evt"), type: "workspace.created", at: timestamp }]
    };
    this.workspaces.unshift(workspace);
    await this.save();
    return publicWorkspace(workspace);
  }

  async addArtifact(workspaceId, input) {
    const workspace = this.raw(workspaceId);
    if (!workspace) throw new Error("Workspace not found");
    const type = input.type === "html" ? "html" : input.type === "image" ? "image" : "";
    if (!type) throw new Error("Only HTML and image artifacts are supported in this release");

    let buffer;
    let ext;
    let contentType;
    if (type === "html") {
      const html = sanitizeHtml(input.content);
      buffer = Buffer.from(html, "utf8");
      if (!buffer.length) throw new Error("HTML artifact is empty");
      if (buffer.length > MAX_HTML_BYTES) throw new Error("HTML artifact exceeds 2 MB");
      ext = "html";
      contentType = "text/html; charset=utf-8";
    } else {
      const match = /^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=]+)$/s.exec(input.dataUrl || "");
      if (!match) throw new Error("Image must be a PNG, JPEG, or WebP data URL");
      buffer = Buffer.from(match[2], "base64");
      if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) throw new Error("Image is empty or exceeds 10 MB");
      ext = match[1] === "jpg" ? "jpeg" : match[1];
      contentType = `image/${ext}`;
    }

    const artifactId = id("art");
    const filename = `${artifactId}.${ext}`;
    const storagePath = path.join(this.artifactRoot, filename);
    await fs.writeFile(storagePath, buffer);
    const timestamp = now();
    const artifact = {
      id: artifactId,
      type,
      name: safeName(input.name, type === "html" ? "Untitled page.html" : `Image.${ext}`),
      revision: revision(buffer),
      contentType,
      storagePath,
      contentUrl: `/api/artifacts/${artifactId}/content`,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    workspace.artifacts.push(artifact);
    workspace.updatedAt = timestamp;
    workspace.events.push({ id: id("evt"), type: "artifact.added", artifactId, at: timestamp });
    await this.save();
    return { ...artifact, storagePath: undefined };
  }

  findArtifact(artifactId) {
    for (const workspace of this.workspaces) {
      const artifact = workspace.artifacts.find(item => item.id === artifactId);
      if (artifact) return { workspace, artifact };
    }
    return null;
  }

  async readArtifact(artifactId) {
    const found = this.findArtifact(artifactId);
    if (!found) return null;
    return {
      artifact: found.artifact,
      buffer: await fs.readFile(found.artifact.storagePath)
    };
  }

  async addAnnotation(workspaceId, input) {
    const workspace = this.raw(workspaceId);
    if (!workspace) throw new Error("Workspace not found");
    const artifact = workspace.artifacts.find(item => item.id === input.artifactId);
    if (!artifact) throw new Error("Artifact not found in workspace");
    const strokes = Array.isArray(input.strokes) ? input.strokes.slice(0, 500) : [];
    if (!strokes.length) throw new Error("Annotation must contain at least one stroke");
    const timestamp = now();
    const annotation = {
      id: id("ann"),
      artifactId: artifact.id,
      artifactRevision: artifact.revision,
      strokes,
      anchor: input.anchor && typeof input.anchor === "object" ? input.anchor : { kind: "viewport" },
      transcription: String(input.transcription || "").slice(0, 2000),
      intent: ["comment", "edit", "question", "task"].includes(input.intent) ? input.intent : "comment",
      createdAt: timestamp
    };
    workspace.annotations.push(annotation);
    workspace.updatedAt = timestamp;
    workspace.events.push({ id: id("evt"), type: "annotation.added", annotationId: annotation.id, at: timestamp });
    await this.save();
    return annotation;
  }

  async createProposal(workspaceId, input) {
    const workspace = this.raw(workspaceId);
    if (!workspace) throw new Error("Workspace not found");
    const artifact = workspace.artifacts.find(item => item.id === input.artifactId);
    if (!artifact) throw new Error("Artifact not found in workspace");
    const timestamp = now();
    const proposal = {
      id: id("prop"),
      artifactId: artifact.id,
      baseRevision: artifact.revision,
      instruction: String(input.instruction || "Review the annotations and propose improvements.").slice(0, 4000),
      annotationIds: Array.isArray(input.annotationIds) ? input.annotationIds : [],
      status: "draft",
      summary: "",
      changes: [],
      createdAt: timestamp,
      updatedAt: timestamp
    };
    workspace.proposals.push(proposal);
    workspace.updatedAt = timestamp;
    workspace.events.push({ id: id("evt"), type: "proposal.created", proposalId: proposal.id, at: timestamp });
    await this.save();
    return proposal;
  }

  async completeProposal(workspaceId, proposalId, result) {
    const workspace = this.raw(workspaceId);
    const proposal = workspace?.proposals.find(item => item.id === proposalId);
    if (!proposal) throw new Error("Proposal not found");
    proposal.status = result.error ? "failed" : "proposed";
    proposal.summary = String(result.summary || result.error || "").slice(0, 12000);
    proposal.changes = Array.isArray(result.changes) ? result.changes.slice(0, 100) : [];
    proposal.updatedAt = now();
    workspace.updatedAt = proposal.updatedAt;
    workspace.events.push({ id: id("evt"), type: `proposal.${proposal.status}`, proposalId, at: proposal.updatedAt });
    await this.save();
    return proposal;
  }
}
