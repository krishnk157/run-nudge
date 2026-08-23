/*
 * Regenerate the README screenshots.
 *
 *   1. start the app:  npm run dev
 *   2. in another shell:  npm run shots
 *
 * The dashboard is behind the ADMIN_TOKEN cookie, so a plain headless
 * `--screenshot` gets the sign-in wall. This drives headless Chrome over the
 * DevTools Protocol instead: it reads the token from .env, sets the cookie
 * directly, and captures full-page desktop + mobile shots plus the chat opened
 * from a chart. Nothing is uploaded and the token is never printed.
 *
 * Node 21+ only (uses the built-in WebSocket). No dependencies.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const BASE = process.env.APP_URL || "http://localhost:3000";
const OUT = path.join(process.cwd(), "docs", "media");
const PORT = 9222;

function readToken() {
  if (process.env.ADMIN_TOKEN) return process.env.ADMIN_TOKEN;
  const env = fs.readFileSync(path.join(process.cwd(), ".env"), "utf8");
  const m = env.match(/^ADMIN_TOKEN=\s*"?([^"\n]+)"?/m);
  if (!m) throw new Error("ADMIN_TOKEN not found in environment or .env");
  return m[1];
}

function chromePath() {
  const candidates =
    process.platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ]
      : process.platform === "win32"
        ? [
            "C:/Program Files/Google/Chrome/Application/chrome.exe",
            "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
          ]
        : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  const found = candidates.find((c) => fs.existsSync(c));
  if (!found) throw new Error(`Chrome not found. Tried:\n${candidates.join("\n")}`);
  return found;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer(url) {
  for (let i = 0; i < 40; i++) {
    try {
      await fetch(url, { redirect: "manual" });
      return;
    } catch {
      await sleep(500);
    }
  }
  throw new Error(`Dev server not reachable at ${url} — run "npm run dev" first.`);
}

async function waitForPort(port) {
  for (let i = 0; i < 40; i++) {
    const ok = await new Promise((res) => {
      const s = net.connect(port, "127.0.0.1");
      s.on("connect", () => (s.end(), res(true)));
      s.on("error", () => res(false));
    });
    if (ok) return;
    await sleep(250);
  }
  throw new Error("Chrome DevTools port never opened.");
}

async function main() {
  const token = readToken();
  await waitForServer(BASE);
  fs.mkdirSync(OUT, { recursive: true });

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "rn-shots-"));
  const chrome = spawn(
    chromePath(),
    [
      "--headless=new",
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      "--hide-scrollbars",
      "--force-color-profile=srgb",
      "--no-first-run",
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  try {
    await waitForPort(PORT);
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
    const target = targets.find((t) => t.type === "page");
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));

    let id = 0;
    const pending = new Map();
    const evHandlers = [];
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)) {
        pending.get(m.id)(m.result);
        pending.delete(m.id);
      } else if (m.method) for (const h of [...evHandlers]) h(m);
    };
    const send = (method, params = {}) =>
      new Promise((res) => {
        const mid = ++id;
        pending.set(mid, res);
        ws.send(JSON.stringify({ id: mid, method, params }));
      });
    const waitEvent = (method) =>
      new Promise((res) => {
        const h = (m) => {
          if (m.method === method) {
            evHandlers.splice(evHandlers.indexOf(h), 1);
            res(m);
          }
        };
        evHandlers.push(h);
      });

    await send("Page.enable");
    await send("Network.enable");
    await send("Runtime.enable");
    await send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: "dark" }],
    });
    await send("Network.setCookie", {
      name: "rn_session",
      value: token,
      domain: "localhost",
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    });
    // Hide the Next.js dev-mode indicator so it never lands in a shot.
    await send("Page.addScriptToEvaluateOnNewDocument", {
      source: `(() => { const s = document.createElement('style'); s.textContent = 'nextjs-portal,[data-next-mark],#__next-dev-tools-indicator,[data-nextjs-dev-tools-button]{display:none!important}'; (document.head||document.documentElement).appendChild(s); })();`,
    });

    const metrics = (w, h, mobile) =>
      send("Emulation.setDeviceMetricsOverride", {
        width: w,
        height: h,
        deviceScaleFactor: 2,
        mobile,
        screenWidth: w,
        screenHeight: h,
      });
    const nav = async () => {
      const done = waitEvent("Page.loadEventFired");
      await send("Page.navigate", { url: `${BASE}/` });
      await Promise.race([done, sleep(6000)]);
      await sleep(1600);
    };
    // The dev-mode indicator lives in a <nextjs-portal> shadow host; hiding the
    // host removes it. Injected right before each capture (a fresh document per
    // navigation would drop an earlier injection).
    const hideDevIndicator = () =>
      send("Runtime.evaluate", {
        expression: `(()=>{const s=document.createElement('style');s.textContent='nextjs-portal{display:none!important}';document.documentElement.appendChild(s);})()`,
      });

    const fullShot = async (file, maxHeightCss) => {
      await hideDevIndicator();
      const lm = await send("Page.getLayoutMetrics");
      const size = lm.cssContentSize || lm.contentSize;
      const height = maxHeightCss ? Math.min(Math.ceil(size.height), maxHeightCss) : Math.ceil(size.height);
      const clip = { x: 0, y: 0, width: Math.ceil(size.width), height, scale: 1 };
      const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip });
      fs.writeFileSync(path.join(OUT, file), Buffer.from(shot.data, "base64"));
      console.log("wrote", file, `${clip.width}x${clip.height} css`);
    };
    const viewportShot = async (file) => {
      await hideDevIndicator();
      const shot = await send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(path.join(OUT, file), Buffer.from(shot.data, "base64"));
      console.log("wrote", file, "(viewport)");
    };

    await metrics(1360, 900, false);
    await nav();
    await fullShot("dashboard-desktop.png");

    // Open the chat from a chart card: it seeds a question about that chart,
    // which is the flow worth showing.
    await send("Runtime.evaluate", { expression: `document.querySelector('.chart .chart-note')?.click()` });
    await sleep(900);
    await viewportShot("chat-seeded.png");

    await metrics(414, 896, true);
    await nav();
    // Cap the mobile shot at the visually rich top (state + coverage + trends);
    // the full single column runs several thousand px and dwarfs the README.
    await fullShot("dashboard-mobile.png", 2600);

    ws.close();
  } finally {
    chrome.kill();
    fs.rmSync(profile, { recursive: true, force: true });
  }
  console.log("done →", OUT);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
