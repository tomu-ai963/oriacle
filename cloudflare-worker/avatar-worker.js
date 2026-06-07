// ============================================
// Oriacle — Spiritual Avatar Worker
// Relays selfie + genre to OpenAI gpt-image-1 (image edit)
// and returns the generated anime-style avatar.
// ES Module format for Cloudflare Workers
// ============================================

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const GENRE_KEYWORDS = {
  cosmic: "cosmic traveler, starfield aura",
  witch: "mystical witch, dark magic, moon witch",
  sage: "ancient sage, wisdom, ethereal light",
  angel: "celestial angel, divine light, wings",
  dragon: "eastern dragon spirit, mystical Asia",
  shrine: "Japanese shrine maiden, sakura spirit",
};

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const DATA_URL_RE = /^data:(image\/(?:png|jpeg));base64,(.+)$/;

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function errorResponse(message, status) {
  return jsonResponse({ error: message }, status);
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

    const prompt = [
      "anime style portrait,", keywords + ",",
      "soft spiritual atmosphere, Studio Ghibli inspired aesthetic,",
      "NOT photorealistic, gentle luminous colors,",
      "mystical background, high quality illustration",
    ].join(" ");

    const extension = mimeType === "image/png" ? "png" : "jpg";
    const form = new FormData();
    form.append("model", "gpt-image-1");
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

    return jsonResponse({ image: `data:image/png;base64,${b64}` });
  },
};
