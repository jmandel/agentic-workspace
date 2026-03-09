/**
 * Test script — creates a workspace via wsmanager, connects to ACP, sends a message.
 *
 * Usage: bun run test.ts
 * Requires: wsmanager running on :31337, docker image agrp-wmlet built.
 */

const MANAGER = "http://localhost:31337";
const WS_NAME = "test-ws";

async function cleanup() {
  console.log(`\n[test] cleaning up workspace ${WS_NAME}...`);
  await fetch(`${MANAGER}/workspaces/${WS_NAME}`, { method: "DELETE" }).catch(() => {});
}

async function main() {
  // Cleanup any leftover
  await cleanup();

  // 1. Create workspace
  console.log("[test] creating workspace...");
  const createRes = await fetch(`${MANAGER}/workspaces`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: WS_NAME }),
  });

  if (!createRes.ok) {
    console.error("[test] create failed:", await createRes.text());
    process.exit(1);
  }

  const workspace = await createRes.json();
  console.log("[test] workspace created:", workspace);

  // 2. Wait for wmlet to start
  console.log("[test] waiting for wmlet to start...");
  const apiUrl = workspace.api;
  for (let i = 0; i < 20; i++) {
    try {
      const res = await fetch(`${apiUrl}/health`);
      if (res.ok) {
        console.log("[test] wmlet is ready");
        break;
      }
    } catch {}
    if (i === 19) {
      console.error("[test] wmlet did not start in time");
      await cleanup();
      process.exit(1);
    }
    await Bun.sleep(1000);
  }

  // 3. Connect via ACP (WebSocket)
  console.log(`[test] connecting to ACP: ${workspace.acp}`);

  const ws = new WebSocket(workspace.acp);

  ws.onopen = () => {
    console.log("[test] ACP connected");
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "connected") {
      console.log(`[test] joined session, history: ${msg.history.length} entries`);

      // Send a test message to claude
      console.log("[test] sending message to claude...");
      ws.send(JSON.stringify({ type: "input", data: "say hello in one word" }));
    } else if (msg.type === "output") {
      process.stdout.write(`[claude] ${msg.data}`);
    } else if (msg.type === "stderr") {
      process.stderr.write(`[claude:err] ${msg.data}`);
    }
  };

  ws.onerror = (err) => {
    console.error("[test] WebSocket error:", err);
  };

  ws.onclose = () => {
    console.log("[test] ACP disconnected");
  };

  // Wait 30s then cleanup
  console.log("[test] waiting 30s for response...");
  await Bun.sleep(30000);

  ws.close();
  await cleanup();
  console.log("[test] done");
}

main().catch((e) => {
  console.error("[test] error:", e);
  cleanup().then(() => process.exit(1));
});
