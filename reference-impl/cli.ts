#!/usr/bin/env bun
/**
 * ws — CLI client for agentic workspace.
 *
 * Usage:
 *   ws list                     — list workspaces
 *   ws create <name>            — create workspace
 *   ws delete <name>            — delete workspace
 *   ws connect <name> [session] — connect to workspace ACP
 *   ws health                   — manager health
 */

const MANAGER = process.env.WS_MANAGER || "http://localhost:31337";

const [cmd, ...args] = process.argv.slice(2);

async function api(path: string, opts?: RequestInit) {
  const res = await fetch(`${MANAGER}${path}`, opts);
  return res.json();
}

async function list() {
  const data = await api("/workspaces");
  if (!data.length) {
    console.log("No workspaces.");
    return;
  }
  console.log("WORKSPACE\tSTATUS\tACP");
  for (const ws of data) {
    console.log(`${ws.name}\t${ws.status}\t${ws.acp}`);
  }
}

async function create(name: string) {
  if (!name) { console.error("Usage: ws create <name>"); process.exit(1); }
  const data = await api("/workspaces", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (data.error) { console.error("Error:", data.error); process.exit(1); }
  console.log(`Created: ${data.name}`);
  console.log(`ACP:     ${data.acp}`);
}

async function del(name: string) {
  if (!name) { console.error("Usage: ws delete <name>"); process.exit(1); }
  const data = await api(`/workspaces/${name}`, { method: "DELETE" });
  if (data.error) { console.error("Error:", data.error); process.exit(1); }
  console.log(`Deleted: ${data.name}`);
}

async function health() {
  const data = await api("/health");
  console.log(JSON.stringify(data, null, 2));
}

async function connect(name: string, session = "default") {
  if (!name) { console.error("Usage: ws connect <name> [session]"); process.exit(1); }

  // Get workspace info
  const ws = await api(`/workspaces/${name}`);
  if (ws.error) { console.error("Error:", ws.error); process.exit(1); }

  const acpUrl = ws.acp + `?session=${session}`;
  console.log(`Connecting to ${acpUrl}...`);

  const socket = new WebSocket(acpUrl);
  let connected = false;

  socket.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    switch (msg.type) {
      case "system":
        console.log(`\x1b[90m[system] ${msg.data}\x1b[0m`);
        break;
      case "connected":
        connected = true;
        console.log(`\x1b[32mConnected to session ${msg.sessionId}\x1b[0m`);
        console.log(`Type a message and press Enter. Ctrl+C to quit.\n`);
        promptInput();
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
        console.error(`\x1b[31m[error] ${msg.data}\x1b[0m`);
        promptInput();
        break;
      default:
        console.log(`[${msg.type}]`, msg.data || "");
    }
  };

  socket.onerror = () => {
    console.error("WebSocket error");
    process.exit(1);
  };

  socket.onclose = () => {
    console.log("\nDisconnected.");
    process.exit(0);
  };

  function promptInput() {
    process.stdout.write("\x1b[36m> \x1b[0m");
  }

  // Read stdin line by line
  const decoder = new TextDecoder();
  for await (const chunk of Bun.stdin.stream()) {
    const lines = decoder.decode(chunk).split("\n").filter(Boolean);
    for (const line of lines) {
      const text = line.trim();
      if (!text) continue;
      if (text === "/quit" || text === "/exit") {
        socket.close();
        process.exit(0);
      }
      if (!connected) continue;
      socket.send(JSON.stringify({ type: "prompt", data: text }));
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
    await create(args[0]);
    break;
  case "delete":
  case "rm":
    await del(args[0]);
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
  list                     List workspaces
  create <name>            Create workspace
  delete <name>            Delete workspace
  connect <name> [session] Connect to workspace
  health                   Manager health`);
}
