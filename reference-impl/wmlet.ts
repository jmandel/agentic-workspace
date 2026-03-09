/**
 * wmlet — workspace agent inside a container.
 *
 * Spawns claude-agent-acp, communicates via ACP (JSON-RPC over stdio).
 * Exposes WebSocket endpoint for external clients to interact with claude.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
} from "@agentclientprotocol/sdk";
import type {
  Client,
  SessionNotification,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";

const PORT = parseInt(process.env.WMLET_PORT || process.env.PORT || "31337");
const WORKSPACE_DIR = process.env.WORKSPACE_DIR || "/workspace";
const BIN_DIR = `${process.cwd()}/node_modules/.bin`;

// --- State ---

interface Session {
  id: string;
  connection: ClientSideConnection;
  process: ChildProcess;
  sessionId: string;
  clients: Set<string>;
  log: Array<{ type: string; data: any; ts: string }>;
  busy: boolean;
}

const sessions = new Map<string, Session>();
const wsClients = new Map<string, any>();

// --- ACP ---

function cleanEnv(): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_SESSION;
  return env;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms)
    ),
  ]);
}

function broadcastToSession(sessionKey: string, msg: any) {
  const session = sessions.get(sessionKey);
  if (!session) return;
  const data = JSON.stringify(msg);
  for (const clientId of session.clients) {
    const ws = wsClients.get(clientId);
    if (ws) ws.send(data);
  }
}

async function createSession(id: string): Promise<Session> {
  console.log(`[wmlet] creating ACP session: ${id}`);

  const command = `${BIN_DIR}/claude-agent-acp`;
  console.log(`[wmlet] spawning: ${command}`);

  const proc = spawn(command, [], {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: WORKSPACE_DIR,
    env: cleanEnv(),
  });

  proc.stderr?.on("data", (chunk: Buffer) => {
    const line = chunk.toString().trim();
    if (line) console.error(`[claude stderr] ${line}`);
  });

  if (!proc.stdin || !proc.stdout) {
    throw new Error("Failed to create ACP stdio pipes");
  }

  const input = Writable.toWeb(proc.stdin);
  const output = Readable.toWeb(proc.stdout) as unknown as ReadableStream<Uint8Array>;
  const stream = ndJsonStream(input, output);

  // Create client handler that broadcasts to WebSocket clients
  const clientImpl: Client = {
    async sessionUpdate(params: SessionNotification): Promise<void> {
      const update = params.update as any;
      const updateType = update.sessionUpdate;
      if (!updateType) return;

      const logEntry = { type: updateType, data: update, ts: new Date().toISOString() };

      const session = sessions.get(id);
      if (session) session.log.push(logEntry);

      switch (updateType) {
        case "agent_message_chunk": {
          const text = update.content?.text;
          if (text) {
            broadcastToSession(id, { type: "text", data: text });
          }
          break;
        }
        case "tool_call": {
          broadcastToSession(id, {
            type: "tool_call",
            toolCallId: update.toolCallId,
            title: update.title,
            kind: update.kind,
            status: update.status,
          });
          break;
        }
        case "tool_call_update": {
          broadcastToSession(id, {
            type: "tool_update",
            toolCallId: update.toolCallId,
            status: update.status,
            title: update.title,
          });
          break;
        }
      }
    },

    async requestPermission(
      params: RequestPermissionRequest
    ): Promise<RequestPermissionResponse> {
      console.log(`[wmlet] permission request:`, JSON.stringify(params));
      // Auto-approve for now
      return { approved: true };
    },
  };

  const connection = new ClientSideConnection(() => clientImpl, stream);

  // Initialize
  console.log(`[wmlet] initializing ACP...`);
  await withTimeout(
    connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
      clientInfo: { name: "wmlet", version: "0.1.0" },
    }),
    30_000,
    "ACP initialize"
  );

  // Create session
  console.log(`[wmlet] creating claude session...`);
  const acpSession = await withTimeout(
    connection.newSession({
      cwd: WORKSPACE_DIR,
      mcpServers: [],
    }),
    30_000,
    "ACP newSession"
  );

  console.log(`[wmlet] session ready: ${acpSession.sessionId}`);

  const session: Session = {
    id,
    connection,
    process: proc,
    sessionId: acpSession.sessionId,
    clients: new Set(),
    log: [],
    busy: false,
  };

  proc.on("exit", (code) => {
    console.log(`[wmlet] claude exited: ${code}`);
    sessions.delete(id);
    broadcastToSession(id, { type: "system", data: `agent exited (${code})` });
  });

  sessions.set(id, session);
  return session;
}

async function promptSession(sessionKey: string, text: string) {
  const session = sessions.get(sessionKey);
  if (!session) return;
  if (session.busy) {
    broadcastToSession(sessionKey, { type: "system", data: "agent is busy, wait..." });
    return;
  }

  session.busy = true;
  broadcastToSession(sessionKey, { type: "system", data: "thinking..." });

  try {
    const result = await session.connection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text }],
    });
    console.log(`[wmlet] prompt done, turns: ${(result as any)?.turns?.length || "?"}`);
    broadcastToSession(sessionKey, { type: "done" });
  } catch (err: any) {
    console.error(`[wmlet] prompt error:`, err);
    broadcastToSession(sessionKey, { type: "error", data: err.message });
  } finally {
    session.busy = false;
  }
}

// --- Server ---

const server = Bun.serve({
  port: PORT,
  fetch(req, server) {
    const url = new URL(req.url);

    if (url.pathname === "/acp") {
      const sessionId = url.searchParams.get("session") || "default";
      const upgraded = server.upgrade(req, { data: { sessionId } });
      if (!upgraded) return new Response("upgrade failed", { status: 400 });
      return undefined;
    }

    if (url.pathname === "/health") {
      return Response.json({
        status: "ok",
        hasApiKey: !!process.env.ANTHROPIC_API_KEY,
        sessions: [...sessions.entries()].map(([k, s]) => ({
          id: k,
          sessionId: s.sessionId,
          clients: s.clients.size,
          busy: s.busy,
          logSize: s.log.length,
        })),
      });
    }

    return new Response("wmlet\n\nGET /health\nWS  /acp?session=<id>\n");
  },

  websocket: {
    async open(ws) {
      const clientId = crypto.randomUUID();
      const sessionKey = (ws.data as any).sessionId;
      (ws as any)._clientId = clientId;
      (ws as any)._sessionId = sessionKey;
      wsClients.set(clientId, ws);

      console.log(`[wmlet] client ${clientId} connecting to session ${sessionKey}`);

      let session = sessions.get(sessionKey);
      if (!session) {
        try {
          ws.send(JSON.stringify({ type: "system", data: "starting agent..." }));
          session = await createSession(sessionKey);
        } catch (err: any) {
          console.error(`[wmlet] failed to create session:`, err);
          ws.send(JSON.stringify({ type: "error", data: err.message }));
          ws.close();
          return;
        }
      }
      session.clients.add(clientId);

      ws.send(JSON.stringify({
        type: "connected",
        session: sessionKey,
        sessionId: session.sessionId,
      }));
    },

    message(ws, raw) {
      const sessionKey = (ws as any)._sessionId;
      const msg = JSON.parse(raw.toString());

      if (msg.type === "prompt") {
        promptSession(sessionKey, msg.data);
      }
    },

    close(ws) {
      const clientId = (ws as any)._clientId;
      const sessionKey = (ws as any)._sessionId;
      wsClients.delete(clientId);
      const session = sessions.get(sessionKey);
      if (session) session.clients.delete(clientId);
      console.log(`[wmlet] client ${clientId} disconnected`);
    },
  },
});

console.log(`[wmlet] listening on :${PORT}`);
console.log(`[wmlet] workspace: ${WORKSPACE_DIR}`);
console.log(`[wmlet] API key: ${process.env.ANTHROPIC_API_KEY ? "present" : "missing"}`);
