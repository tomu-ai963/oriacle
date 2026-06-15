// ============================================
// Oriacle — community-worker.js
// ES Module format for Cloudflare Workers
// ============================================

const CORS_ORIGIN = "https://tomu-ai963.github.io";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": CORS_ORIGIN,
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// Bearer session auth (shared with the main worker).
// Sessions live in MYSTIC_SUBSCRIPTIONS KV under session:<sessionId> → { userId, expiry }.
const SESSION_PREFIX = "session:";

function getBearer(request) {
  const auth = request.headers.get("Authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

// Verify the Bearer session and return the userId (btoa(email)), or null.
async function authenticate(request, env) {
  const sessionId = getBearer(request);
  if (!sessionId) return null;
  try {
    const data = await env.MYSTIC_SUBSCRIPTIONS.get(SESSION_PREFIX + sessionId);
    if (!data) return null;
    const session = JSON.parse(data);
    if (session.expiry && session.expiry < Date.now()) {
      await env.MYSTIC_SUBSCRIPTIONS.delete(SESSION_PREFIX + sessionId);
      return null;
    }
    return session.userId || null;
  } catch {
    return null;
  }
}

const FEED_MAX = 100;
const POST_TTL_SECONDS = 90 * 24 * 60 * 60; // 90 days
const MAX_RESULT_TEXT = 1000;
const MAX_USER_COMMENT = 200;

// Crockford base32 alphabet
const ULID_CHARS = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function generateULID() {
  const now = Date.now();
  let id = "";

  // 10 characters = 50-bit timestamp (Crockford base32)
  let t = now;
  for (let i = 9; i >= 0; i--) {
    id = ULID_CHARS[t % 32] + id;
    t = Math.floor(t / 32);
  }

  // 16 characters = 80 bits of randomness
  for (let i = 0; i < 16; i++) {
    id += ULID_CHARS[Math.floor(Math.random() * 32)];
  }

  return id;
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

// Reads planRank from MYSTIC_SUBSCRIPTIONS KV.
// Subscription schema: { active, plan, planRank?, expires, username?, avatarUrl? }
// planRank 0 = free, 1 = Plus, 2 = Pro
async function getPlanRank(userId, env) {
  try {
    const raw = await env.MYSTIC_SUBSCRIPTIONS.get(userId);
    if (!raw) return 0;
    const sub = JSON.parse(raw);
    if (!sub.active) return 0;
    if (sub.expires && new Date(sub.expires) < new Date()) return 0;
    if (typeof sub.planRank === "number") return sub.planRank;
    // Fallback: any active subscription without an explicit planRank is Plus
    return 1;
  } catch {
    return 0;
  }
}

async function getUserProfile(userId, env) {
  try {
    const raw = await env.MYSTIC_SUBSCRIPTIONS.get(userId);
    if (!raw) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    const userId = await authenticate(request, env);
    if (!userId) return jsonResponse({ error: "Unauthorized" }, 401);

    const planRank = await getPlanRank(userId, env);

    try {
      if (method === "POST" && path === "/post") {
        return handlePost(request, env, userId, planRank);
      }
      if (method === "GET" && path === "/feed") {
        return handleFeed(env, planRank);
      }
      if (method === "POST" && path === "/like") {
        return handleLike(request, env, userId, planRank);
      }
      return jsonResponse({ error: "Not Found" }, 404);
    } catch {
      return jsonResponse({ error: "Internal Server Error" }, 500);
    }
  },
};

async function handlePost(request, env, userId, planRank) {
  if (planRank < 2) return jsonResponse({ error: "Pro plan required" }, 403);

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  const { appName, resultText, userComment = "" } = body;

  if (!appName || typeof appName !== "string" || !appName.trim()) {
    return jsonResponse({ error: "appName is required" }, 400);
  }
  if (!resultText || typeof resultText !== "string" || !resultText.trim()) {
    return jsonResponse({ error: "resultText is required" }, 400);
  }
  if (resultText.length > MAX_RESULT_TEXT) {
    return jsonResponse({ error: `resultText must be at most ${MAX_RESULT_TEXT} characters` }, 400);
  }
  if (typeof userComment !== "string" || userComment.length > MAX_USER_COMMENT) {
    return jsonResponse({ error: `userComment must be at most ${MAX_USER_COMMENT} characters` }, 400);
  }

  const profile = await getUserProfile(userId, env);

  const id = generateULID();
  const post = {
    id,
    userId,
    username: profile.username || userId.slice(0, 8),
    avatarUrl: profile.avatarUrl || null,
    appName: appName.trim(),
    resultText: resultText.trim(),
    userComment: userComment.trim(),
    createdAt: new Date().toISOString(),
    likes: 0,
  };

  // Persist post and update feed index in parallel
  const feedRaw = await env.COMMUNITY.get("feed:index");
  const feed = feedRaw ? JSON.parse(feedRaw) : [];
  feed.unshift(id);
  if (feed.length > FEED_MAX) feed.length = FEED_MAX;

  await Promise.all([
    env.COMMUNITY.put(`post:${id}`, JSON.stringify(post), {
      expirationTtl: POST_TTL_SECONDS,
    }),
    env.COMMUNITY.put("feed:index", JSON.stringify(feed)),
  ]);

  return jsonResponse(post, 201);
}

async function handleFeed(env, planRank) {
  if (planRank < 1) return jsonResponse({ error: "Plus or Pro plan required" }, 403);

  const feedRaw = await env.COMMUNITY.get("feed:index");
  if (!feedRaw) return jsonResponse([]);

  const ids = JSON.parse(feedRaw);

  const posts = await Promise.all(
    ids.map(async (id) => {
      const raw = await env.COMMUNITY.get(`post:${id}`);
      return raw ? JSON.parse(raw) : null;
    })
  );

  return jsonResponse(posts.filter(Boolean));
}

async function handleLike(request, env, userId, planRank) {
  if (planRank < 1) return jsonResponse({ error: "Plus or Pro plan required" }, 403);

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  const { postId } = body;
  if (!postId || typeof postId !== "string") {
    return jsonResponse({ error: "postId is required" }, 400);
  }

  const likeKey = `like:${postId}:${userId}`;

  const [alreadyLiked, postRaw] = await Promise.all([
    env.COMMUNITY.get(likeKey),
    env.COMMUNITY.get(`post:${postId}`),
  ]);

  if (alreadyLiked) return jsonResponse({ error: "Already liked" }, 409);
  if (!postRaw) return jsonResponse({ error: "Post not found" }, 404);

  const post = JSON.parse(postRaw);
  post.likes = (post.likes || 0) + 1;

  await Promise.all([
    env.COMMUNITY.put(`post:${postId}`, JSON.stringify(post), {
      expirationTtl: POST_TTL_SECONDS,
    }),
    env.COMMUNITY.put(likeKey, "1", { expirationTtl: POST_TTL_SECONDS }),
  ]);

  return jsonResponse({ likes: post.likes });
}
