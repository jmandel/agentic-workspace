#!/usr/bin/env bun
/**
 * ws — CLI client for agentic workspace.
 *
 * Usage:
 *   ws list                         — list workspaces
 *   ws create <name>                — create workspace
 *   ws delete <name>                — delete workspace
 *   ws topics <name>                — list topics in workspace
 *   ws queue <name> <topic>         — show topic queue
 *   ws clear-queue <name> <topic>   — clear my queued prompts
 *   ws connect <name> [topic]       — connect to topic (default: general)
 *   ws health                       — manager health
 */

const MANAGER = process.env.WS_MANAGER || "http://localhost:31337";
const WS_CLIENT_ID =
  process.env.WS_CLIENT_ID ||
  `cli-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const [cmd, ...args] = process.argv.slice(2);

async function api(url: string, opts?: RequestInit) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let data: any = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }
  if (!res.ok) {
    return { error: (data && (data.error || data.raw)) || text || `HTTP ${res.status}`, status: res.status };
  }
  if (data === null) {
    return { ok: true, status: res.status };
  }
  if (typeof data === "object" && data !== null && !Array.isArray(data)) {
    return { ...data, status: res.status };
  }
  return data;
}

async function managerApi(path: string, opts?: RequestInit) {
  return api(`${MANAGER}${path}`, opts);
}

// Get workspace API base URL
async function wsApi(name: string): Promise<string> {
  const ws = await managerApi(`/workspaces/${name}`);
  if (ws.error) { console.error("Error:", ws.error); process.exit(1); }
  return ws.api;
}

function requestHeaders() {
  return { "X-Workspace-Client-ID": WS_CLIENT_ID };
}

function nextPromptIdFactory() {
  let counter = 0;
  return () => {
    counter += 1;
    return `p_${WS_CLIENT_ID}_${counter}`;
  };
}

function printQueueSnapshot(snapshot: any) {
  const active = snapshot.activePromptId ? `active=${snapshot.activePromptId}` : "active=none";
  console.log(`\x1b[90m[queue] ${active}\x1b[0m`);
  if (!Array.isArray(snapshot.entries) || snapshot.entries.length === 0) {
    console.log(`\x1b[90m[queue] no queued prompts\x1b[0m`);
    return;
  }
  for (const entry of snapshot.entries) {
    const owner = entry.submittedBy?.id || "unknown";
    console.log(`\x1b[90m[queue] #${entry.position} ${entry.promptId} ${entry.status} by ${owner}: ${entry.text}\x1b[0m`);
  }
}

async function queue(name: string, topic = "general") {
  if (!name) { console.error("Usage: ws queue <workspace> <topic>"); process.exit(1); }
  const base = await wsApi(name);
  const data = await api(`${base}/topics/${encodeURIComponent(topic)}/queue`, {
    headers: requestHeaders(),
  });
  if (data.error) { console.error("Error:", data.error); process.exit(1); }
  printQueueSnapshot(data);
}

async function clearQueue(name: string, topic = "general") {
  if (!name) { console.error("Usage: ws clear-queue <workspace> <topic>"); process.exit(1); }
  const base = await wsApi(name);
  const data = await api(`${base}/topics/${encodeURIComponent(topic)}/queue:clear-mine`, {
    method: "POST",
    headers: requestHeaders(),
  });
  if (data.error) { console.error("Error:", data.error); process.exit(1); }
  const removed = Array.isArray(data.removed) ? data.removed : [];
  console.log(`Cleared ${removed.length} queued prompt(s).`);
  if (removed.length > 0) {
    console.log(removed.join("\n"));
  }
}

async function list() {
  const data = await managerApi("/workspaces");
  if (!data.length) { console.log("No workspaces."); return; }
  console.log("WORKSPACE\tSTATUS\tACP");
  for (const ws of data) {
    console.log(`${ws.name}\t${ws.status}\t${ws.acp}`);
  }
}

async function create(name: string, topicNames: string[]) {
  if (!name) { console.error("Usage: ws create <name> [topic1 topic2 ...]"); process.exit(1); }
  const body: any = { name };
  if (topicNames.length > 0) body.topics = topicNames;
  const data = await managerApi("/workspaces", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (data.error) { console.error("Error:", data.error); process.exit(1); }
  console.log(`Created: ${data.name}`);
  console.log(`ACP:     ${data.acp}`);
  if (data.topics?.length) {
    console.log(`Topics:  ${data.topics.join(", ")}`);
  }
}

async function del(name: string) {
  if (!name) { console.error("Usage: ws delete <name>"); process.exit(1); }
  const data = await managerApi(`/workspaces/${name}`, { method: "DELETE" });
  if (data.error) { console.error("Error:", data.error); process.exit(1); }
  console.log(`Deleted: ${data.name}`);
}

async function listTopics(name: string) {
  if (!name) { console.error("Usage: ws topics <workspace>"); process.exit(1); }
  const base = await wsApi(name);
  const data = await api(`${base}/topics`);
  if (!data.length) { console.log("No topics. Connect to create one."); return; }
  console.log("TOPIC\t\tCLIENTS\tBUSY\tCREATED");
  for (const t of data) {
    console.log(`${t.name}\t\t${t.clients}\t${t.busy}\t${t.createdAt}`);
  }
}

async function health() {
  const data = await managerApi("/health");
  console.log(JSON.stringify(data, null, 2));
}

async function connect(name: string, topic = "general") {
  if (!name) { console.error("Usage: ws connect <name> [topic]"); process.exit(1); }

  const ws = await managerApi(`/workspaces/${name}`);
  if (ws.error) { console.error("Error:", ws.error); process.exit(1); }

  // Build ACP URL: ws://host:port/acp/<topic>
  const acpBase = ws.acp.replace(/\/acp$/, "");
  const acpUrl = `${acpBase}/acp/${topic}?client_id=${encodeURIComponent(WS_CLIENT_ID)}`;
  const apiBase = ws.api;
  console.log(`Connecting to ${acpUrl}...`);
  console.log(`Using participant id ${WS_CLIENT_ID}`);

  const socket = new WebSocket(acpUrl);
  let connected = false;
  const nextPromptId = nextPromptIdFactory();
  const promptStates = new Map<string, string>();
  const ownPrompts: string[] = [];

  socket.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    switch (msg.type) {
      case "system":
        console.log(`\x1b[90m[system] ${msg.data}\x1b[0m`);
        break;
      case "connected":
        connected = true;
        console.log(`\x1b[32mConnected to topic "${msg.topic}" (session ${msg.sessionId})\x1b[0m`);
        console.log(`Type a message and press Enter. /quit to disconnect.\n`);
        promptInput();
        break;
      case "queue_snapshot":
        printQueueSnapshot(msg);
        break;
      case "prompt_status":
        promptStates.set(msg.promptId, msg.status);
        console.log(`\x1b[90m[prompt] ${msg.promptId} ${msg.status}${msg.position ? ` (#${msg.position})` : ""}\x1b[0m`);
        break;
      case "text":
        process.stdout.write(msg.data);
        break;
      case "tool_call":
        console.log(`\x1b[33m[tool] ${msg.title} (${msg.status})\x1b[0m`);
        break;
      case "tool_update":
        if (msg.status === "completed") {
          console.log(`\x1b[33m[tool] ${msg.title || msg.toolCallId} done\x1b[0m`);
        }
        break;
      case "done":
        console.log(`\n\x1b[90m---\x1b[0m`);
        promptInput();
        break;
      case "error":
        if (msg.promptId) {
          console.error(`\x1b[31m[error] ${msg.promptId}: ${msg.data}\x1b[0m`);
        } else {
          console.error(`\x1b[31m[error] ${msg.data}\x1b[0m`);
        }
        promptInput();
        break;
      case "queue_entry_removed":
        console.log(`\x1b[90m[queue] removed ${msg.promptId} (${msg.reason || "removed"})\x1b[0m`);
        break;
      case "queue_cleared":
        console.log(`\x1b[90m[queue] cleared ${Array.isArray(msg.removed) ? msg.removed.join(", ") : ""}\x1b[0m`);
        break;
      default:
        console.log(`[${msg.type}]`, msg.data || "");
    }
  };

  socket.onerror = () => { console.error("WebSocket error"); process.exit(1); };
  socket.onclose = () => { console.log("\nDisconnected."); process.exit(0); };

  function promptInput() {
    process.stdout.write(`\x1b[36m[${topic}]> \x1b[0m`);
  }

  async function showQueue() {
    const data = await api(`${apiBase}/topics/${encodeURIComponent(topic)}/queue`, {
      headers: requestHeaders(),
    });
    if (data.error) {
      console.error(`\x1b[31m[error] ${data.error}\x1b[0m`);
      return;
    }
    printQueueSnapshot(data);
  }

  async function cancelPrompt(id: string) {
    let promptId = id;
    if (promptId === "last") {
      const pending = ownPrompts.filter((candidate) => promptStates.get(candidate) === "queued");
      promptId = pending[pending.length - 1];
      if (!promptId) {
        console.error(`\x1b[31m[error] no queued prompt to cancel\x1b[0m`);
        return;
      }
    }
    const data = await api(`${apiBase}/topics/${encodeURIComponent(topic)}/queue/${encodeURIComponent(promptId)}`, {
      method: "DELETE",
      headers: requestHeaders(),
    });
    if (data.error && data.status !== 204) {
      console.error(`\x1b[31m[error] ${data.error}\x1b[0m`);
      return;
    }
    console.log(`\x1b[90m[queue] cancel requested for ${promptId}\x1b[0m`);
  }

  async function clearMine() {
    const data = await api(`${apiBase}/topics/${encodeURIComponent(topic)}/queue:clear-mine`, {
      method: "POST",
      headers: requestHeaders(),
    });
    if (data.error) {
      console.error(`\x1b[31m[error] ${data.error}\x1b[0m`);
      return;
    }
    const removed = Array.isArray(data.removed) ? data.removed : [];
    console.log(`\x1b[90m[queue] cleared ${removed.length} prompt(s)\x1b[0m`);
  }

  const decoder = new TextDecoder();
  for await (const chunk of Bun.stdin.stream()) {
    const lines = decoder.decode(chunk).split("\n").filter(Boolean);
    for (const line of lines) {
      const text = line.trim();
      if (!text) continue;
      if (text === "/quit" || text === "/exit") { socket.close(); process.exit(0); }
      if (text === "/queue") {
        await showQueue();
        promptInput();
        continue;
      }
      if (text === "/clear") {
        await clearMine();
        promptInput();
        continue;
      }
      if (text.startsWith("/cancel ")) {
        await cancelPrompt(text.slice("/cancel ".length).trim());
        promptInput();
        continue;
      }
      if (text === "/whoami") {
        console.log(`participant ${WS_CLIENT_ID}`);
        promptInput();
        continue;
      }
      if (!connected) continue;
      const promptId = nextPromptId();
      ownPrompts.push(promptId);
      promptStates.set(promptId, "accepted");
      socket.send(JSON.stringify({ type: "prompt", promptId, data: text }));
    }
  }
}

// --- Main ---

switch (cmd) {
  case "list":
  case "ls":
    await list();
    break;
  case "create":
    await create(args[0], args.slice(1));
    break;
  case "delete":
  case "rm":
    await del(args[0]);
    break;
  case "topics":
    await listTopics(args[0]);
    break;
  case "queue":
    await queue(args[0], args[1]);
    break;
  case "clear-queue":
    await clearQueue(args[0], args[1]);
    break;
  case "connect":
  case "c":
    await connect(args[0], args[1]);
    break;
  case "health":
    await health();
    break;
  default:
    console.log(`ws — agentic workspace CLI

Commands:
  list                       List workspaces
  create <name> [topics...]  Create workspace (optionally with topics)
  delete <name>              Delete workspace
  topics <name>              List topics in workspace
  queue <name> <topic>       Show topic queue
  clear-queue <name> <topic> Clear my queued prompts for a topic
  connect <name> [topic]     Connect to topic (default: general)
  health                     Manager health`);
}
