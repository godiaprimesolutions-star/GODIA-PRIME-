const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

const AI_MODEL = "@cf/zai-org/glm-4.7-flash";
const SESSION_SECONDS = 7 * 24 * 60 * 60;
const CURRENT_PIN_ITERATIONS = 100000;
const LEGACY_PIN_ITERATIONS = 100000;

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...extra }
  });
}

function fail(message, status = 400) {
  return json({ ok: false, message }, status);
}

function b64(bytes) {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromB64(value) {
  return Uint8Array.from(atob(value), c => c.charCodeAt(0));
}

function randomToken(bytes = 32) {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  return b64(value).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function sha256(value) {
  return b64(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function derivePin(pin, salt, iterations = CURRENT_PIN_ITERATIONS) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pin),
    "PBKDF2",
    false,
    ["deriveBits"]
  );

  const bits = await crypto.subtle.deriveBits({
    name: "PBKDF2",
    salt: fromB64(salt),
    iterations,
    hash: "SHA-256"
  }, key, 256);

  return b64(bits);
}

function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) {
    return false;
  }
  let difference = 0;
  for (let i = 0; i < a.length; i++) {
    difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return difference === 0;
}

function cookie(name, value, maxAge) {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=${maxAge}`;
}

function getCookie(request, name) {
  const raw = request.headers.get("Cookie") || "";
  const item = raw.split(";").map(x => x.trim()).find(x => x.startsWith(name + "="));
  return item ? item.slice(name.length + 1) : null;
}

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.startsWith("0") && digits.length === 10) return "254" + digits.slice(1);
  if (digits.startsWith("254") && digits.length === 12) return digits;
  if (digits.startsWith("7") && digits.length === 9) return "254" + digits;
  return null;
}

function localPhone(value) {
  return value && value.startsWith("254") ? "0" + value.slice(3) : null;
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254;
}

async function readJson(request) {
  return await request.json().catch(() => null);
}

async function currentUser(request, env) {
  const token = getCookie(request, "gpc_session");
  if (!token || !env.DB) return null;

  const tokenHash = await sha256(token);
  return await env.DB.prepare(`
    SELECT u.id, u.name, u.email, u.phone
    FROM gpce_sessions s
    JOIN gpce_users u ON u.id = s.user_id
    WHERE s.token_hash = ?
      AND s.revoked_at IS NULL
      AND julianday(s.expires_at) > julianday('now')
    LIMIT 1
  `).bind(tokenHash).first();
}

async function createSession(user, env) {
  const token = randomToken();
  const tokenHash = await sha256(token);

  await env.DB.prepare(`
    INSERT INTO gpce_sessions
      (id, user_id, token_hash, created_at, expires_at)
    VALUES (?, ?, ?, datetime('now'), datetime('now', '+7 days'))
  `).bind(crypto.randomUUID(), user.id, tokenHash).run();

  return token;
}

async function register(request, env) {
  const input = await readJson(request);
  if (!input) return fail("Invalid JSON request.");

  const name = String(input.name || "").trim();
  const email = String(input.email || "").trim().toLowerCase();
  const phone = normalizePhone(input.phone);
  const pin = String(input.pin || "");

  if (
    name.length < 2 ||
    name.length > 100 ||
    !validEmail(email) ||
    !phone ||
    !/^\d{4,8}$/.test(pin)
  ) {
    return fail("Provide your full name, valid email, Kenyan phone number and a 4–8 digit PIN.");
  }

  const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
  const pinHash = await derivePin(pin, salt, CURRENT_PIN_ITERATIONS);
  const id = crypto.randomUUID();

  try {
    await env.DB.prepare(`
      INSERT INTO gpce_users
        (id, name, email, phone, pin_salt, pin_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `).bind(id, name, email, phone, salt, pinHash).run();
  } catch (error) {
    const message = String(error?.message || "");
    if (/UNIQUE constraint failed/i.test(message)) {
      return fail("An account with that email or phone number already exists.", 409);
    }
    console.error("GODIA PRIME registration database error:", error);
    return fail("Registration could not be completed. Please try again.", 500);
  }

  return json({
    ok: true,
    message: "Account registered successfully.",
    user: { id, name, email, phone }
  }, 201);
}

async function login(request, env) {
  const input = await readJson(request);
  if (!input) return fail("Invalid JSON request.");

  const phone = normalizePhone(input.phone);
  const pin = String(input.pin || "");

  if (!phone || !/^\d{4,8}$/.test(pin)) {
    return fail("Enter your registered phone number and 4–8 digit PIN.");
  }

  const local = localPhone(phone);
  const user = await env.DB.prepare(`
    SELECT id, name, email, phone, pin_salt, pin_hash
    FROM gpce_users
    WHERE phone = ?
       OR phone = ?
       OR REPLACE(phone, '+', '') = ?
    LIMIT 1
  `).bind(phone, local || phone, phone).first();

  if (!user) return fail("Phone number or PIN is incorrect.", 401);

  // New registrations use 210,000 iterations. The 100,000-iteration
  // fallback keeps accounts created by the earlier Worker working.
  let candidate = await derivePin(pin, user.pin_salt, CURRENT_PIN_ITERATIONS);
  let valid = constantTimeEqual(candidate, user.pin_hash);

  if (!valid) {
    candidate = await derivePin(pin, user.pin_salt, LEGACY_PIN_ITERATIONS);
    valid = constantTimeEqual(candidate, user.pin_hash);
  }

  if (!valid) return fail("Phone number or PIN is incorrect.", 401);

  const token = await createSession(user, env);

  return json({
    ok: true,
    message: "Login successful.",
    user: { id: user.id, name: user.name, email: user.email, phone: user.phone }
  }, 200, {
    "set-cookie": cookie("gpc_session", token, SESSION_SECONDS)
  });
}

async function logout(request, env) {
  const token = getCookie(request, "gpc_session");

  if (token && env.DB) {
    await env.DB.prepare(`
      UPDATE gpce_sessions
      SET revoked_at = datetime('now')
      WHERE token_hash = ? AND revoked_at IS NULL
    `).bind(await sha256(token)).run();
  }

  return json({ ok: true, message: "Logged out." }, 200, {
    "set-cookie": cookie("gpc_session", "", 0)
  });
}

async function runBusinessAI(request, env) {
  if (!env.AI) return fail("Cloudflare Workers AI binding is not connected.", 503);

  const user = await currentUser(request, env);
  if (!user) return fail("Please sign in to use GODIA PRIME AI.", 401);

  const input = await readJson(request) || {};
  const prompt = String(input.message || input.prompt || "").trim();
  const task = String(input.task || "agent").toLowerCase();

  if (!prompt || prompt.length > 5000) {
    return fail("Enter a message between 1 and 5000 characters.");
  }

  const instructions = {
    agent: "You are GODIA PRIME AI Agent. Assist users with business questions, planning, problem solving, business operations and entrepreneurship.",
    marketing: "You are GODIA PRIME Marketing Assistant. Create attractive advertisements, promotional campaigns, social media posts, business jingles and customer-attracting marketing content.",
    products: "You are GODIA PRIME Product Assistant. Create professional product titles, descriptions, selling points and catalogue content. Never invent product specifications, stock availability or prices.",
    business: "You are GODIA PRIME Business Assistant. Help entrepreneurs improve sales, customer service, stock management, business planning, business operations and business growth."
  };

  if (!instructions[task]) {
    return fail("Unknown AI task. Choose agent, marketing, products or business.");
  }

  const history = Array.isArray(input.history)
    ? input.history
        .filter(m => m && ["user", "assistant"].includes(m.role))
        .slice(-8)
        .map(m => ({
          role: m.role,
          content: String(m.content || "").slice(0, 1500)
        }))
        .filter(m => m.content.trim())
    : [];

  try {
    const result = await env.AI.run(AI_MODEL, {
      messages: [
        {
          role: "system",
          content:
            instructions[task] +
            " You serve businesses in Kenya. Understand Kenyan Shillings (KES), M-Pesa, local markets and entrepreneurship. Be accurate, professional, practical and helpful. Reply in the language requested. Never claim to have accessed live records, completed payments or performed actions you have not performed."
        },
        ...history,
        { role: "user", content: prompt }
      ],
      max_tokens: 1000,
      temperature: 0.6
    });

    const answer = result?.response || result?.result?.response;
    if (typeof answer !== "string" || !answer.trim()) {
      return fail("AI could not generate a response. Please try again.", 502);
    }

    return json({ ok: true, task, model: AI_MODEL, answer: answer.trim() });
  } catch (error) {
    console.error("GODIA PRIME AI error:", error);
    return fail("AI service is temporarily unavailable. Please try again.", 502);
  }
}

function mpesaShortcode(env) {
  return String(env.MPESA_SHORTCODE || env.MPESA_SHORT || "").trim();
}

async function mpesaToken(env) {
  const key = env.MPESA_CONSUMER_KEY;
  const secret = env.MPESA_CONSUMER_SECRET;

  if (!key || !secret) {
    throw new Error("Missing MPESA_CONSUMER_KEY or MPESA_CONSUMER_SECRET.");
  }

  const auth = btoa(`${key}:${secret}`);
  const response = await fetch(
    "https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials",
    { headers: { Authorization: `Basic ${auth}` } }
  );

  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) {
    throw new Error(body.error_description || body.errorMessage || "Safaricom OAuth failed.");
  }

  return body.access_token;
}

function mpesaTimestamp() {
  const d = new Date();
  return (
    d.getFullYear().toString() +
    String(d.getMonth() + 1).padStart(2, "0") +
    String(d.getDate()).padStart(2, "0") +
    String(d.getHours()).padStart(2, "0") +
    String(d.getMinutes()).padStart(2, "0") +
    String(d.getSeconds()).padStart(2, "0")
  );
}

async function startStk(request, env) {
  const user = await currentUser(request, env);
  if (!user) return fail("Please sign in before making a payment.", 401);

  const shortcode = mpesaShortcode(env);
  const tillNumber = String(env.MPESA_TILL_NUMBER || shortcode).trim();
  const passkey = env.MPESA_PASSKEY;
  const callbackUrl = env.MPESA_CALLBACK_URL;

  if (!shortcode || !passkey || !callbackUrl) {
    return fail("M-Pesa shortcode, passkey or callback URL is missing.", 503);
  }

  if (String(env.MPESA_ENV || "").toLowerCase() !== "production") {
    return fail("Production mode is not enabled. Set MPESA_ENV=production.", 503);
  }

  const input = await readJson(request) || {};
  const phone = normalizePhone(input.phone || user.phone);
  const amount = Math.floor(Number(input.amount));

  if (!phone) return fail("Enter a valid Kenyan Safaricom number.");
  if (!Number.isInteger(amount) || amount < 1 || amount > 250000) {
    return fail("Amount must be a whole number between KES 1 and KES 250,000.");
  }

  try {
    const timestamp = mpesaTimestamp();
    const password = btoa(shortcode + passkey + timestamp);
    const accessToken = await mpesaToken(env);
    const transactionType = env.MPESA_TRANSACTION_TYPE || "CustomerBuyGoodsOnline";

    const payload = {
      BusinessShortCode: shortcode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: transactionType,
      Amount: amount,
      PartyA: phone,
      PartyB: tillNumber,
      PhoneNumber: phone,
      CallBackURL: callbackUrl,
      AccountReference: String(input.accountReference || "GODIAPRIME").slice(0, 12),
      TransactionDesc: String(input.description || "GODIA PRIME payment").slice(0, 13)
    };

    const response = await fetch(
      "https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      }
    );

    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ResponseCode !== "0") {
      console.error("Safaricom STK error:", result);
      return json({
        ok: false,
        message: result.errorMessage || result.ResponseDescription || "Safaricom rejected the STK request."
      }, 502);
    }

    const paymentId = crypto.randomUUID();

    await env.DB.prepare(`
      INSERT INTO gpce_payments
        (id, user_id, phone, amount, currency, status,
         merchant_request_id, checkout_request_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'KES', 'PENDING', ?, ?, datetime('now'), datetime('now'))
    `).bind(
      paymentId,
      user.id,
      phone,
      amount,
      result.MerchantRequestID,
      result.CheckoutRequestID
    ).run();

    return json({
      ok: true,
      message: result.CustomerMessage || "STK push sent. Check your phone and enter your M-Pesa PIN.",
      paymentId,
      checkoutRequestId: result.CheckoutRequestID,
      status: "PENDING"
    });
  } catch (error) {
    console.error("GODIA PRIME M-Pesa STK error:", error);
    return fail("M-Pesa could not start the payment. Please try again or contact support.", 502);
  }
}

async function mpesaCallback(request, env) {
  const body = await readJson(request);
  const callback = body?.Body?.stkCallback;

  if (!callback?.CheckoutRequestID) {
    return fail("Invalid callback payload.");
  }

  const resultCode = Number(callback.ResultCode);
  const items = callback.CallbackMetadata?.Item || [];
  const pick = name => items.find(item => item.Name === name)?.Value ?? null;

  await env.DB.prepare(`
    UPDATE gpce_payments
    SET status = ?,
        result_code = ?,
        result_description = ?,
        mpesa_receipt = ?,
        confirmed_amount = ?,
        confirmed_phone = ?,
        callback_json = ?,
        updated_at = datetime('now')
    WHERE checkout_request_id = ?
  `).bind(
    resultCode === 0 ? "SUCCESS" : "FAILED",
    resultCode,
    String(callback.ResultDesc || ""),
    pick("MpesaReceiptNumber"),
    pick("Amount"),
    pick("PhoneNumber"),
    JSON.stringify(callback),
    callback.CheckoutRequestID
  ).run();

  return json({ ResultCode: 0, ResultDesc: "Accepted" });
}

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method;

  if (method === "GET" && path === "/api/health") {
    const paymentsConfigured =
      String(env.MPESA_ENV || "").toLowerCase() === "production" &&
      !!env.MPESA_CONSUMER_KEY &&
      !!env.MPESA_CONSUMER_SECRET &&
      !!mpesaShortcode(env) &&
      !!env.MPESA_PASSKEY &&
      !!env.MPESA_CALLBACK_URL;

    return json({
      ok: true,
      service: "GODIA PRIME CONNECT API",
      database: !!env.DB,
      ai: env.AI ? "connected" : "not-configured",
      ai_model: AI_MODEL,
      payments: paymentsConfigured ? "production-configured-mode" : "not-enabled"
    });
  }

  if (path.startsWith("/api/") && !env.DB) {
    return fail("D1 database binding DB is not configured.", 500);
  }

  if (method === "POST" && path === "/api/auth/register") {
    return register(request, env);
  }

  if (method === "POST" && path === "/api/auth/login") {
    return login(request, env);
  }

  if (method === "POST" && path === "/api/auth/logout") {
    return logout(request, env);
  }

  if (method === "GET" && path === "/api/auth/me") {
    const user = await currentUser(request, env);
    return user ? json({ ok: true, user }) : fail("Not signed in.", 401);
  }

  if (method === "POST" && path === "/api/ai/chat") {
    return runBusinessAI(request, env);
  }

  if (method === "POST" && path === "/api/payments/mpesa/stkpush") {
    return startStk(request, env);
  }

  if (method === "POST" && path === "/api/mpesa/callback") {
    return mpesaCallback(request, env);
  }

  if (method === "GET" && path.startsWith("/api/payments/")) {
    const user = await currentUser(request, env);
    if (!user) return fail("Please sign in.", 401);

    const paymentId = path.split("/").pop();
    const payment = await env.DB.prepare(`
      SELECT id, amount, currency, status, mpesa_receipt, created_at, updated_at
      FROM gpce_payments
      WHERE id = ? AND user_id = ?
      LIMIT 1
    `).bind(paymentId, user.id).first();

    return payment ? json({ ok: true, payment }) : fail("Payment not found.", 404);
  }

  if (path.startsWith("/api/")) {
    return fail("API route not found.", 404);
  }

  if (env.ASSETS) return env.ASSETS.fetch(request);
  return fail("Static assets binding ASSETS is not configured.", 500);
}

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean);
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

function withCors(response, origin) {
  if (!origin) return response;
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders(origin))) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

export default {
  async fetch(request, env) {
    try {
      const requestUrl = new URL(request.url);
      const origin = request.headers.get("Origin") || "";
      const sameOrigin = !!origin && origin === requestUrl.origin;
      const allowed = allowedOrigins(env);
      const permitted = !origin || sameOrigin || allowed.includes(origin);

      if (origin && !permitted) {
        return fail("Origin not allowed.", 403);
      }

      if (request.method === "OPTIONS") {
        if (!origin || !permitted) return fail("Origin not allowed.", 403);
        return new Response(null, {
          status: 204,
          headers: corsHeaders(origin)
        });
      }

      const response = await route(request, env);
      return permitted && origin ? withCors(response, origin) : response;
    } catch (error) {
      console.error("GODIA PRIME API error:", error);
      const response = fail("The server could not complete the request. Check Worker logs for details.", 500);
      const origin = request.headers.get("Origin") || "";
      const sameOrigin = origin && origin === new URL(request.url).origin;
      const permitted = !origin || sameOrigin || allowedOrigins(env).includes(origin);
      return permitted && origin ? withCors(response, origin) : response;
    }
  }
};
