// Tiny API client for local integration scripts.
// Uses node:http without keep-alive: Node's built-in fetch (undici) shows ~3 s keep-alive
// stalls against PocketBase on this host (curl and browsers do not), which skews timing tests.
import http from "node:http";

export const PB = process.env.PB || "http://127.0.0.1:8201";

export function req(path, { method = "GET", token, body } = {}) {
  const url = new URL(PB + path);
  const payload = body ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const r = http.request(
      url,
      {
        method,
        agent: false,
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: token } : {}),
          ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (text += c));
        res.on("end", () => {
          let data;
          try {
            data = JSON.parse(text);
          } catch {
            data = { raw: text };
          }
          resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, data });
        });
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

export async function waitHealthy(ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await req("/api/health");
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("PocketBase not healthy at " + PB);
}

export async function user(email, password = "testpass99") {
  await req("/api/collections/users/records", {
    method: "POST",
    body: { email, password, passwordConfirm: password, display_name: email.split("@")[0] },
  });
  const r = await req("/api/collections/users/auth-with-password", { method: "POST", body: { identity: email, password } });
  if (!r.ok) throw new Error("login failed " + email + " " + JSON.stringify(r.data));
  return { token: r.data.token, id: r.data.record.id, email };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
