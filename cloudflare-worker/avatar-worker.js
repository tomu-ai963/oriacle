// ============================================
// Oriacle — Spiritual Avatar Worker
// Relays selfie + genre to OpenAI gpt-image-1-mini (image edit)
// and returns the generated anime-style avatar.
// ES Module format for Cloudflare Workers
// ============================================

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const GENRE_KEYWORDS = {
  cosmic: "cosmic traveler, celestial energy, galaxy aura, stars, nebula light, universe spirit",
  witch: "mystical witch, moon magic, glowing runes, enchanted forest, dark elegance",
  sage: "ancient sage, wisdom energy, sacred light, ethereal glow, mystical knowledge",
  angel: "celestial angel, divine glow, heavenly aura, ethereal feathers, sacred light",
  dragon: "eastern dragon spirit, golden dragon energy, mystical eastern fantasy, sacred mist",
  shrine: "Japanese shrine maiden, sacred sakura petals, spiritual shrine aura, moonlit sanctuary",
};

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const DATA_URL_RE = /^data:(image\/(?:png|jpeg));base64,(.+)$/;

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS, ...extraHeaders },
  });
}

function errorResponse(message, status, extraHeaders = {}) {
  return jsonResponse({ error: message }, status, extraHeaders);
}

// ============================================
// Rate limiting (Cloudflare KV: AVATAR_RATE_LIMIT)
// Tracks generations per IP per calendar month.
// Keyed by tier so a future paid plan can grant a higher monthly limit
// without changing the limiting logic itself — just add an entry here
// and teach resolveTier() to recognize subscribed users.
// ============================================
const RATE_LIMIT_TTL_SECONDS = 35 * 24 * 60 * 60; // ~35 days — keys expire into the next month on their own

const TIER_LIMITS = {
  free: 3,
  // paid: 30, // reserved for a future paid tier
};

function resolveTier(request, env) {
  // Everyone is on the free tier for now. A future paid tier would inspect
  // an auth/subscription signal here (e.g. a header or KV lookup) and
  // return "paid" so TIER_LIMITS["paid"] applies instead.
  return "free";
}

function getClientIp(request) {
  return request.headers.get("CF-Connecting-IP") || "unknown";
}

function getYearMonth(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function getNextMonthFirstDay(date) {
  const next = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
  return next.toISOString().slice(0, 10);
}

async function checkRateLimit(request, env) {
  const tier = resolveTier(request, env);
  const limit = TIER_LIMITS[tier] ?? TIER_LIMITS.free;
  const now = new Date();
  const key = `ip:${getClientIp(request)}:${getYearMonth(now)}`;
  const resetDate = getNextMonthFirstDay(now);

  const stored = await env.AVATAR_RATE_LIMIT.get(key);
  const count = stored ? (parseInt(stored, 10) || 0) : 0;

  return { key, limit, count, resetDate, exceeded: count >= limit };
}

function rateLimitHeaders(limit, remaining, resetDate) {
  return {
    "X-RateLimit-Limit": String(limit),
    "X-RateLimit-Remaining": String(Math.max(0, remaining)),
    "X-RateLimit-Reset": resetDate,
  };
}

async function recordGeneration(env, key, currentCount) {
  await env.AVATAR_RATE_LIMIT.put(key, String(currentCount + 1), {
    expirationTtl: RATE_LIMIT_TTL_SECONDS,
  });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    if (url.pathname !== "/avatar/generate") {
      return errorResponse("Not Found ｜ ページが見つかりません", 404);
    }
    if (request.method !== "POST") {
      return errorResponse("Method Not Allowed ｜ 許可されていないメソッドです", 405);
    }

    const rateLimit = await checkRateLimit(request, env);
    if (rateLimit.exceeded) {
      return jsonResponse(
        {
          error: "Monthly limit reached. / 今月の生成上限に達しました。",
          limit: rateLimit.limit,
          resetInfo: "Resets at the start of next month. / 来月初めにリセットされます。",
        },
        429,
        rateLimitHeaders(rateLimit.limit, 0, rateLimit.resetDate)
      );
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return errorResponse("Invalid request body ｜ リクエストの形式が不正です", 400);
    }

    const { image, genre } = body || {};
    const keywords = GENRE_KEYWORDS[genre];
    if (!keywords) {
      return errorResponse("Please select a valid genre ｜ ジャンルを選択してください", 400);
    }
    if (typeof image !== "string") {
      return errorResponse("Please upload a photo ｜ 写真をアップロードしてください", 400);
    }

    const match = DATA_URL_RE.exec(image);
    if (!match) {
      return errorResponse("Only JPG/PNG photos are supported ｜ JPGまたはPNG画像のみ対応しています", 400);
    }
    const [, mimeType, base64Data] = match;

    let bytes;
    try {
      const binary = atob(base64Data);
      bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    } catch {
      return errorResponse("Could not read the photo ｜ 写真を読み込めませんでした", 400);
    }

    if (bytes.length > MAX_IMAGE_BYTES) {
      return errorResponse("Photo must be 5MB or smaller ｜ 写真は5MB以内にしてください", 400);
    }

    const prompt = `
Create this person's higher spiritual self as a beautiful anime portrait.

Preserve the person's identity and recognizable facial features.
The result should feel like an idealized spiritual version of the same person.
Do not create a different person. Do not dramatically alter facial structure.

Natural beauty enhancement:
- clear expressive eyes
- healthy glowing skin
- balanced facial proportions
- elegant anime styling

${keywords}

Mystical aura. Sacred energy. Dreamlike celestial atmosphere.
Fantasy lighting. High-quality anime illustration.
Profile picture quality. Centered portrait.
`;

    const extension = mimeType === "image/png" ? "png" : "jpg";
    const form = new FormData();
    form.append("model", "gpt-image-1-mini");
    form.append("image", new Blob([bytes], { type: mimeType }), `selfie.${extension}`);
    form.append("prompt", prompt);
    form.append("size", "1024x1024");
    form.append("n", "1");

    let aiResponse;
    try {
      aiResponse = await fetch("https://api.openai.com/v1/images/edits", {
        method: "POST",
        headers: { "Authorization": `Bearer ${env.OPENAI_API_KEY}` },
        body: form,
      });
    } catch (err) {
      console.error("OpenAI request failed:", err);
      return errorResponse("Could not reach the spirit realm — please try again ｜ 接続できませんでした。もう一度お試しください", 502);
    }

    if (!aiResponse.ok) {
      const detail = await aiResponse.text().catch(() => "");
      console.error("OpenAI error:", aiResponse.status, detail);
      return errorResponse("Avatar generation failed ｜ アバターの生成に失敗しました", 502);
    }

    const aiData = await aiResponse.json().catch(() => null);
    const b64 = aiData?.data?.[0]?.b64_json;
    if (!b64) {
      console.error("OpenAI response missing image data:", JSON.stringify(aiData));
      return errorResponse("Avatar generation failed ｜ アバターの生成に失敗しました", 502);
    }

    await recordGeneration(env, rateLimit.key, rateLimit.count);

    return jsonResponse(
      { image: `data:image/png;base64,${b64}` },
      200,
      rateLimitHeaders(rateLimit.limit, rateLimit.limit - (rateLimit.count + 1), rateLimit.resetDate)
    );
  },
};
