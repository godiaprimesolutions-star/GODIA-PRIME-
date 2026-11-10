
const APP_NAME = "GODIA PRIME CONNECT ENTERPRISE";
const SESSION_DAYS = 30;
const PIN_ITERATIONS = 100000;

function json(data, status = 200, origin = "*") {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Cache-Control": "no-store"
    }
  });
}

function getOrigin(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = env.ALLOWED_ORIGINS || "*";

  if (allowed === "*") return "*";

  const origins = allowed.split(",").map(x => x.trim());
  return origins.includes(origin) ? origin : "null";
}

function makeId() {
  return crypto.randomUUID();
}

function toBase64(bytes) {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function randomSalt() {
  return toBase64(crypto.getRandomValues(new Uint8Array(16)));
}

async function hashPIN(pin, salt) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pin),
    "PBKDF2",
    false,
    ["deriveBits"]
  );

  const result = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: Uint8Array.from(atob(salt), c => c.charCodeAt(0)),
      iterations: PIN_ITERATIONS,
      hash: "SHA-256"
    },
    key,
    256
  );

  return toBase64(result);
}

async function hashToken(token) {
  const result = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token)
  );
  return toBase64(result);
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validPhone(phone) {
  return /^\+?[0-9]{10,15}$/.test(phone);
}

function validPIN(pin) {
  return /^\d{4,8}$/.test(pin);
}

async function readBody(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

async function authenticate(request, env) {
  const authorization = request.headers.get("Authorization") || "";
  const token = authorization.startsWith("Bearer ")
    ? authorization.slice(7).trim()
    : "";

  if (!token) return null;

  const tokenHash = await hashToken(token);

  return await env.DB.prepare(`
    SELECT
      s.id AS session_id,
      s.user_id,
      u.name,
      u.email,
      u.phone
    FROM gpce_sessions s
    JOIN gpce_users u ON u.id = s.user_id
    WHERE s.token_hash = ?
      AND s.revoked_at IS NULL
      AND s.expires_at > ?
    LIMIT 1
  `).bind(tokenHash, new Date().toISOString()).first();
}

async function register(request, env, origin) {
  const body = await readBody(request);

  if (!body) {
    return json({ success: false, message: "Invalid JSON request." }, 400, origin);
  }

  const name = String(body.name || "").trim();
  const email = String(body.email || "").trim().toLowerCase();
  const phone = String(body.phone || "").trim();
  const pin = String(body.pin || "");

  if (!name || name.length > 100) {
    return json({ success: false, message: "Enter a valid full name." }, 400, origin);
  }

  if (!validEmail(email) || email.length > 254) {
    return json({ success: false, message: "Enter a valid email address." }, 400, origin);
  }

  if (!validPhone(phone)) {
    return json({ success: false, message: "Enter a valid phone number." }, 400, origin);
  }

  if (!validPIN(pin)) {
    return json({ success: false, message: "PIN must contain 4 to 8 digits." }, 400, origin);
  }

  const existing = await env.DB.prepare(`
    SELECT id FROM gpce_users
    WHERE email = ? OR phone = ?
    LIMIT 1
  `).bind(email, phone).first();

  if (existing) {
    return json({
      success: false,
      message: "An account with this email or phone already exists."
    }, 409, origin);
  }

  const id = makeId();
  const salt = randomSalt();
  const pinHash = await hashPIN(pin, salt);
  const createdAt = new Date().toISOString();

  await env.DB.prepare(`
    INSERT INTO gpce_users
      (id, name, email, phone, pin_salt, pin_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id, name, email, phone, salt, pinHash, createdAt
  ).run();

  return json({
    success: true,
    message: "Account registered successfully.",
    user: { id, name, email, phone }
  }, 201, origin);
}

async function login(request, env, origin) {
  const body = await readBody(request);

  if (!body) {
    return json({ success: false, message: "Invalid JSON request." }, 400, origin);
  }

  const phone = String(body.phone || "").trim();
  const pin = String(body.pin || "");

  if (!validPhone(phone) || !validPIN(pin)) {
    return json({ success: false, message: "Invalid phone number or PIN." }, 400, origin);
  }

  const user = await env.DB.prepare(`
    SELECT id, name, email, phone, pin_salt, pin_hash
    FROM gpce_users
    WHERE phone = ?
    LIMIT 1
  `).bind(phone).first();

  if (!user) {
    return json({ success: false, message: "Invalid phone number or PIN." }, 401, origin);
  }

  const suppliedHash = await hashPIN(pin, user.pin_salt);

  if (suppliedHash !== user.pin_hash) {
    return json({ success: false, message: "Invalid phone number or PIN." }, 401, origin);
  }

  const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
  const token = toBase64(tokenBytes);
  const tokenHash = await hashToken(token);

  const sessionId = makeId();
  const createdAt = new Date();
  const expiresAt = new Date(
    createdAt.getTime() + SESSION_DAYS * 24 * 60 * 60 * 1000
  );

  await env.DB.prepare(`
    INSERT INTO gpce_sessions
      (id, user_id, token_hash, created_at, expires_at, revoked_at)
    VALUES (?, ?, ?, ?, ?, NULL)
  `).bind(
    sessionId,
    user.id,
    tokenHash,
    createdAt.toISOString(),
    expiresAt.toISOString()
  ).run();

  return json({
    success: true,
    message: "Login successful.",
    token,
    expires_at: expiresAt.toISOString(),
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone
    }
  }, 200, origin);
}

async function logout(request, env, origin) {
  const authorization = request.headers.get("Authorization") || "";
  const token = authorization.startsWith("Bearer ")
    ? authorization.slice(7).trim()
    : "";

  if (!token) {
    return json({ success: false, message: "Authentication required." }, 401, origin);
  }

  const tokenHash = await hashToken(token);

  await env.DB.prepare(`
    UPDATE gpce_sessions
    SET revoked_at = ?
    WHERE token_hash = ? AND revoked_at IS NULL
  `).bind(new Date().toISOString(), tokenHash).run();

  return json({
    success: true,
    message: "Logged out successfully."
  }, 200, origin);
}

export default {
  async fetch(request, env) {
    const origin = getOrigin(request, env);

    try {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": origin,
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
            "Access-Control-Max-Age": "86400"
          }
        });
      }

      if (origin === "null") {
        return json({ success: false, message: "Origin not allowed." }, 403, origin);
      }

      if (!env.DB) {
        return json({
          success: false,
          message: "D1 database binding DB is not configured."
        }, 500, origin);
      }

      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, "") || "/";

      if (request.method === "GET" && path === "/api/health") {
        return json({
          success: true,
          app: APP_NAME,
          message: "Backend is working.",
          environment: env.ENVIRONMENT || "unknown",
          database: "connected"
        }, 200, origin);
      }

      if (request.method === "POST" && path === "/api/auth/register") {
        return await register(request, env, origin);
      }

      if (request.method === "POST" && path === "/api/auth/login") {
        return await login(request, env, origin);
      }

      if (request.method === "POST" && path === "/api/auth/logout") {
        return await logout(request, env, origin);
      }

      if (request.method === "GET" && path === "/api/auth/me") {
        const user = await authenticate(request, env);

        if (!user) {
          return json({
            success: false,
            message: "Session is invalid or expired."
          }, 401, origin);
        }

        return json({
          success: true,
          user: {
            id: user.user_id,
            name: user.name,
            email: user.email,
            phone: user.phone
          }
        }, 200, origin);
      }

      return json({
        success: false,
        message: "API route not found."
      }, 404, origin);

    } catch (error) {
      console.error("Worker error:", error);

      return json({
        success: false,
        message: "A server error occurred."
      }, 500, origin);
    }
  }
};
