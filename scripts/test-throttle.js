// Isolated test for SessionsManager.throttleSend pacing logic.
// Reimplements only the throttle method (identical logic) to verify timing.
require("dotenv").config();

const SEND_MIN_GAP_MS = parseInt(process.env.WA_SEND_MIN_GAP_MS || "2500", 10);
const SEND_JITTER_MS = parseInt(process.env.WA_SEND_JITTER_MS || "2000", 10);

const sendThrottle = new Map();

async function throttleSend(key) {
  const now = Date.now();
  const last = sendThrottle.get(key) || 0;
  const wait =
    last + SEND_MIN_GAP_MS + Math.floor(Math.random() * SEND_JITTER_MS) - now;
  if (wait > 0) {
    await new Promise((r) => setTimeout(r, wait));
  }
  sendThrottle.set(key, Date.now());
}

(async () => {
  const key = "test-session";
  const gaps = [];
  const sends = 8;

  for (let i = 0; i < sends; i++) {
    const t0 = Date.now();
    await throttleSend(key);
    const waited = Date.now() - t0;
    if (i > 0) gaps.push(waited);
    process.stdout.write(`send #${i + 1}: waited ${waited}ms\n`);
  }

  const min = Math.min(...gaps);
  const max = Math.max(...gaps);

  console.log("\n--- RESULT ---");
  console.log(`WA_SEND_MIN_GAP_MS = ${SEND_MIN_GAP_MS}`);
  console.log(`WA_SEND_JITTER_MS  = ${SEND_JITTER_MS}`);
  console.log(`measured min wait = ${min}ms (${sends - 1} samples)`);
  console.log(`measured max wait = ${max}ms`);

  let ok = true;
  if (min < SEND_MIN_GAP_MS) {
    console.log(`FAIL: min wait ${min}ms < required ${SEND_MIN_GAP_MS}ms`);
    ok = false;
  } else {
    console.log(`PASS: throttle enforces >= ${SEND_MIN_GAP_MS}ms between sends`);
  }

  if (max - min < 200) {
    console.log(`WARN: jitter looks static (range ${max - min}ms)`);
  } else {
    console.log(
      `PASS: jitter present (spread ${max - min}ms within 0-${SEND_JITTER_MS} window)`,
    );
  }

  process.exit(ok ? 0 : 1);
})();
