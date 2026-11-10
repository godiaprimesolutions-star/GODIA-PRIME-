
const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

const AI_MODEL = "@cf/zai-org/glm-4.7-flash";

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
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

function fromB64(value) {
  return Uint8Array.from(atob(value), c => c.charCodeAt(0));
}

function randomToken(bytes = 32) {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return b64(a).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function sha256(value) {
  return b64(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  ));
}

async function derivePin(pin, salt) {
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
    iterations: 210000,
    hash: "SHA-256"
  }, key, 256);

  return b64(bits);
}

function cookie(name, value, maxAge) {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

function getCookie(request, name) {
  const raw = request.headers.get("Cookie") || "";
  const item = raw.split(";")
    .map(x => x.trim())
    .find(x => x.startsWith(name + "="));

  return item ? item.slice(name.length + 1) : null;
}

async function currentUser(request, env) {
  const token = getCookie(request, "gpc_session");
  if (!token) return null;

  const tokenHash = await sha256(token);

  const row = await env.DB.prepare(
    `SELECT u.id,u.name,u.email,u.phone
     FROM gpce_sessions s
     JOIN gpce_users u ON u.id=s.user_id
     WHERE s.token_hash=?
     AND s.revoked_at IS NULL
     AND s.expires_at > datetime('now')`
  ).bind(tokenHash).first();

  return row || null;
}

function requireEnv(env, names) {
  const missing = names.filter(n => !env[n]);

  if (missing.length) {
    throw new Error(
      "Missing Cloudflare secret/configuration: " + missing.join(", ")
    );
  }
}

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");

  if (digits.startsWith("0") && digits.length === 10)
    return "254" + digits.slice(1);

  if (digits.startsWith("254") && digits.length === 12)
    return digits;

  if (digits.startsWith("7") && digits.length === 9)
    return "254" + digits;

  return null;
}

/* ==========================================
   GODIA PRIME CONNECT - CLOUDflare AI
========================================== */

async function runBusinessAI(request, env) {
  if (!env.AI) {
    return fail("Cloudflare Workers AI binding is not connected.", 503);
  }

  const user = await currentUser(request, env);

  if (!user) {
    return fail("Please sign in to use GODIA PRIME AI.", 401);
  }

  const input = await request.json().catch(() => ({}));

  const prompt = String(
    input.message || input.prompt || ""
  ).trim();

  const task = String(
    input.task || "agent"
  ).toLowerCase();

  if (!prompt || prompt.length > 5000) {
    return fail("Enter a message between 1 and 5000 characters.");
  }

  const instructions = {
    agent:
      "You are GODIA PRIME AI Agent. Assist users with business questions, planning, problem solving, business operations and entrepreneurship.",

    marketing:
      "You are GODIA PRIME Marketing Assistant. Create attractive advertisements, promotional campaigns, social media posts, business jingles and customer-attracting marketing content.",

    products:
      "You are GODIA PRIME Product Assistant. Create professional product titles, descriptions, selling points and catalogue content. Never invent product specifications, stock availability or prices.",

    business:
      "You are GODIA PRIME Business Assistant. Help entrepreneurs improve sales, customer service, stock management, business planning, business operations and business growth."
  };

  if (!instructions[task]) {
    return fail(
      "Unknown AI task. Choose agent, marketing, products or business."
    );
  }

  const history = Array.isArray(input.history)
    ? input.history
        .filter(m =>
          m &&
          ["user", "assistant"].includes(m.role)
        )
        .slice(-8)
        .map(m => ({
          role: m.role,
          content: String(m.content || "").slice(0, 1500)
        }))
        .filter(m => m.content.trim())
    : [];

  const messages = [
    {
      role: "system",
      content:
        instructions[task] +
        " You serve businesses in Kenya. Understand Kenyan Shillings (KES), M-Pesa, local markets and entrepreneurship. Be accurate, professional, practical and helpful. Reply in the language requested by the user. Never claim to have accessed live business records, completed payments or performed actions that you have not actually performed."
    },
    ...history,
    {
      role: "user",
      content: prompt
    }
  ];

  try {
    const result = await env.AI.run(AI_MODEL, {
      messages,
      max_tokens: 1000,
      temperature: 0.6
    });

    const answer =
      result?.response ||
      result?.result?.response;

    if (typeof answer !== "string" || !answer.trim()) {
      console.error("Unexpected Workers AI response.");
      return fail("AI could not generate a response. Please try again.", 502);
    }

    return json({
      ok: true,
      task,
      model: AI_MODEL,
      answer: answer.trim()
    });

  } catch (error) {
    console.error("GODIA PRIME AI error:", error);

    return fail(
      "AI service is temporarily unavailable. Please try again.",
      502
    );
  }
}

/* ==========================================
   MPESA DARAJA
========================================== */

async function mpesaToken(env) {
  requireEnv(env, [
    "MPESA_CONSUMER_KEY",
    "MPESA_CONSUMER_SECRET"
  ]);

  const auth = btoa(
    `${env.MPESA_CONSUMER_KEY}:${env.MPESA_CONSUMER_SECRET}`
  );

  const r = await fetch(
    "https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials",
    {
      headers: {
        Authorization: `Basic ${auth}`
      }
    }
  );

  const body = await r.json();

  if (!r.ok || !body.access_token) {
    throw new Error(
      "Safaricom OAuth failed: " +
      (body.error_description || body.errorMessage || r.status)
    );
  }

  return body.access_token;
}

function mpesaTimestamp() {
  const d = new Date();

  return d.getFullYear().toString() +
    String(d.getMonth() + 1).padStart(2, "0") +
    String(d.getDate()).padStart(2, "0") +
    String(d.getHours()).padStart(2, "0") +
    String(d.getMinutes()).padStart(2, "0") +
    String(d.getSeconds()).padStart(2, "0");
}

async function startStk(request, env) {
  const user = await currentUser(request, env);

  if (!user) {
    return fail("Please sign in before making a payment.", 401);
  }

  requireEnv(env, [
    "MPESA_CONSUMER_KEY",
    "MPESA_CONSUMER_SECRET",
    "MPESA_SHORTCODE",
    "MPESA_PASSKEY",
    "MPESA_CALLBACK_URL"
  ]);

  if (env.MPESA_ENV !== "production") {
    return fail(
      "Production mode is not enabled. Set MPESA_ENV=production.",
      503
    );
  }

  const input = await request.json().catch(() => ({}));

  const phone = normalizePhone(input.phone || user.phone);
  const amount = Math.floor(Number(input.amount));

  if (!phone) {
    return fail("Enter a valid Kenyan Safaricom number.");
  }

  if (
    !Number.isInteger(amount) ||
    amount < 1 ||
    amount > 250000
  ) {
    return fail(
      "Amount must be a whole number between KES 1 and KES 250,000."
    );
  }

  const timestamp = mpesaTimestamp();
  const shortcode = String(env.MPESA_SHORTCODE);

  const password = btoa(
    shortcode + env.MPESA_PASSKEY + timestamp
  );

  const accessToken = await mpesaToken(env);

  const payload = {
    BusinessShortCode: shortcode,
    Password: password,
    Timestamp: timestamp,
    TransactionType:
      env.MPESA_TRANSACTION_TYPE || "CustomerPayBillOnline",
    Amount: amount,
    PartyA: phone,
    PartyB: shortcode,
    PhoneNumber: phone,
    CallBackURL: env.MPESA_CALLBACK_URL,
    AccountReference: String(
      input.accountReference || "GODIAPRIME"
    ).slice(0, 12),
    TransactionDesc: String(
      input.description || "GODIA PRIME payment"
    ).slice(0, 13)
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
    return json({
      ok: false,
      message:
        result.errorMessage ||
        result.ResponseDescription ||
        "Safaricom rejected the STK request.",
      provider: result
    }, 502);
  }

  const id = crypto.randomUUID();

  await env.DB.prepare(
    `INSERT INTO gpce_payments
     (id,user_id,phone,amount,currency,status,
      merchant_request_id,checkout_request_id,created_at,updated_at)
     VALUES(?,?,?,?,'KES','PENDING',?,?,datetime('now'),datetime('now'))`
  ).bind(
    id,
    user.id,
    phone,
    amount,
    result.MerchantRequestID,
    result.CheckoutRequestID
  ).run();

  return json({
    ok: true,
    message:
      result.CustomerMessage ||
      "STK push sent. Check the phone and enter your M-Pesa PIN.",
    paymentId: id,
    checkoutRequestId: result.CheckoutRequestID,
    status: "PENDING"
  });
}

async function mpesaCallback(request, env) {
  const body = await request.json().catch(() => null);
  const callback = body?.Body?.stkCallback;

  if (!callback?.CheckoutRequestID) {
    return fail("Invalid callback payload.", 400);
  }

  const resultCode = Number(callback.ResultCode);
  const metadata = callback.CallbackMetadata?.Item || [];

  const pick = name =>
    metadata.find(x => x.Name === name)?.Value ?? null;

  const receipt = pick("MpesaReceiptNumber");
  const paidAmount = pick("Amount");
  const phone = pick("PhoneNumber");

  await env.DB.prepare(
    `UPDATE gpce_payments
     SET status=?, result_code=?, result_description=?,
         mpesa_receipt=?, confirmed_amount=?,
         confirmed_phone=?, callback_json=?,
         updated_at=datetime('now')
     WHERE checkout_request_id=?`
  ).bind(
    resultCode === 0 ? "SUCCESS" : "FAILED",
    resultCode,
    String(callback.ResultDesc || ""),
    receipt,
    paidAmount,
    phone,
    JSON.stringify(callback),
    callback.CheckoutRequestID
  ).run();

  return json({
    ResultCode: 0,
    ResultDesc: "Accepted"
  });
}

/* ==========================================
   API ROUTES
========================================== */

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;

  /* HEALTH CHECK */

  if (
    request.method === "GET" &&
    path === "/api/health"
  ) {
    return json({
      ok: true,
      service: "GODIA PRIME CONNECT API",
      database: !!env.DB,
      ai: env.AI ? "connected" : "not-configured",
      ai_model: AI_MODEL,
      payments:
        env.MPESA_ENV === "production"
          ? "production-configured-mode"
          : "not-enabled"
    });
  }

  /* AI ASSISTANT */

  if (
    request.method === "POST" &&
    path === "/api/ai/chat"
  ) {
    return runBusinessAI(request, env);
  }

  /* REGISTER */

  if (
    request.method === "POST" &&
    path === "/api/auth/register"
  ) {
    const x = await request.json().catch(() => ({}));

    const name = String(x.name || "").trim();
    const email = String(x.email || "").trim().toLowerCase();
    const phone = normalizePhone(x.phone);
    const pin = String(x.pin || "");

    if (
      name.length < 2 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      !phone ||
      !/^\d{4,8}$/.test(pin)
    ) {
      return fail(
        "Provide name, valid email, Kenyan phone number and a 4–8 digit PIN."
      );
    }

    const saltBytes = crypto.getRandomValues(new Uint8Array(16));
    const salt = b64(saltBytes);
    const pinHash = await derivePin(pin, salt);
    const id = crypto.randomUUID();

    try {
      await env.DB.prepare(
        `INSERT INTO gpce_users
         (id,name,email,phone,pin_salt,pin_hash,created_at)
         VALUES(?,?,?,?,?,?,datetime('now'))`
      ).bind(
        id,
        name,
        email,
        phone,
        salt,
        pinHash
      ).run();

    } catch (e) {
      return fail(
        "An account with that email or phone may already exist.",
        409
      );
    }

    return json({
      ok: true,
      user: { id, name, email, phone }
    }, 201);
  }

  /* LOGIN */

  if (
    request.method === "POST" &&
    path === "/api/auth/login"
  ) {
    const x = await request.json().catch(() => ({}));

    const phone = normalizePhone(x.phone);
    const pin = String(x.pin || "");

    if (!phone || !/^\d{4,8}$/.test(pin)) {
      return fail(
        "Enter your registered phone number and PIN."
      );
    }

    const user = await env.DB.prepare(
      `SELECT id,name,email,phone,pin_salt,pin_hash
       FROM gpce_users WHERE phone=?`
    ).bind(phone).first();

    if (
      !user ||
      await derivePin(pin, user.pin_salt) !== user.pin_hash
    ) {
      return fail(
        "Phone number or PIN is incorrect.",
        401
      );
    }

    const token = randomToken();
    const tokenHash = await sha256(token);

    await env.DB.prepare(
      `INSERT INTO gpce_sessions
       (id,user_id,token_hash,created_at,expires_at)
       VALUES(?,?,?,datetime('now'),datetime('now','+7 days'))`
    ).bind(
      crypto.randomUUID(),
      user.id,
      tokenHash
    ).run();

    return json({
      ok: true,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone
      }
    }, 200, {
      "set-cookie": cookie("gpc_session", token, 604800)
    });
  }

  /* LOGOUT */

  if (
    request.method === "POST" &&
    path === "/api/auth/logout"
  ) {
    const token = getCookie(request, "gpc_session");

    if (token) {
      await env.DB.prepare(
        `UPDATE gpce_sessions
         SET revoked_at=datetime('now')
         WHERE token_hash=?`
      ).bind(await sha256(token)).run();
    }

    return json(
      { ok: true },
      200,
      { "set-cookie": cookie("gpc_session", "", 0) }
    );
  }

  /* CURRENT USER */

  if (
    request.method === "GET" &&
    path === "/api/auth/me"
  ) {
    const user = await currentUser(request, env);

    return user
      ? json({ ok: true, user })
      : fail("Not signed in.", 401);
  }

  /* MPESA STK PUSH */

  if (
    request.method === "POST" &&
    path === "/api/payments/mpesa/stkpush"
  ) {
    return startStk(request, env);
  }

  /* MPESA CALLBACK */

  if (
    request.method === "POST" &&
    path === "/api/mpesa/callback"
  ) {
    return mpesaCallback(request, env);
  }

  /* PAYMENT STATUS */

  if (
    request.method === "GET" &&
    path.startsWith("/api/payments/")
  ) {
    const user = await currentUser(request, env);

    if (!user) {
      return fail("Please sign in.", 401);
    }

    const id = path.split("/").pop();

    const row = await env.DB.prepare(
      `SELECT id,amount,currency,status,mpesa_receipt,
              created_at,updated_at
       FROM gpce_payments
       WHERE id=? AND user_id=?`
    ).bind(id, user.id).first();

    return row
      ? json({ ok: true, payment: row })
      : fail("Payment not found.", 404);
  }

  /* UNKNOWN API ROUTE */

  if (path.startsWith("/api/")) {
    return fail("API route not found.", 404);
  }

  /* STATIC WEBSITE */

  if (env.ASSETS) {
    return env.ASSETS.fetch(request);
  }

  return fail(
    "Static assets binding ASSETS is not configured.",
    500
  );
}

/* ==========================================
   MAIN WORKER
========================================== */

export default {
  async fetch(request, env) {
    try {
      if (request.method === "OPTIONS") {
        const origin = request.headers.get("Origin") || "";
        const allowed = env.ALLOWED_ORIGINS || "*";

        const permitted =
          allowed === "*" ||
          allowed.split(",").map(x => x.trim()).includes(origin);

        if (!permitted) {
          return fail("Origin not allowed.", 403);
        }

        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin":
              allowed === "*" ? "*" : origin,
            "Access-Control-Allow-Credentials": "true",
            "Access-Control-Allow-Headers":
              "Content-Type",
            "Access-Control-Allow-Methods":
              "GET,POST,OPTIONS",
            "Vary": "Origin"
          }
        });
      }

      return await route(request, env);

    } catch (error) {
      console.error(
        "GODIA PRIME API error",
        error
      );

      return fail(
        error?.message || "Internal server error.",
        500
      );
    }
  }
};
