const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 4184);
const BASE_URL = process.env.OPENAI_BASE_URL;
const API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_MODEL || "deepseek-v4-flash";

const publicDir = __dirname;

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml"
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/analyze") {
      await handleAnalyze(req, res);
      return;
    }

    if (req.method !== "GET") {
      sendJson(res, 405, { error: "Method not allowed" });
      return;
    }

    serveStatic(url.pathname, res);
  } catch (error) {
    sendJson(res, 500, { error: "服务暂时不可用" });
  }
});

async function handleAnalyze(req, res) {
  if (!BASE_URL) {
    sendJson(res, 500, { error: "后端未配置 OPENAI_BASE_URL" });
    return;
  }

  if (!API_KEY) {
    sendJson(res, 500, { error: "后端未配置 OPENAI_API_KEY" });
    return;
  }

  const body = await readJson(req);
  const systemPrompt = [
    "你是短视频创作者增长方向的 AI 产品运营专家。",
    "你需要根据创作者画像、近几条视频数据和规则诊断，生成中文复盘建议。",
    "要求：输出必须具体、可执行、像真实创作者运营建议，不要泛泛而谈。",
    "只能输出 JSON，不要输出 Markdown，不要解释。",
    "JSON 字段：diagnosisTitle, diagnosisText, focus, bestVideo, weakVideo, suggestions, plan。",
    "suggestions 是数组，每项包含 label 和 text。",
    "plan 是 7 项数组，每项包含 day 和 text。"
  ].join("\n");

  const userPrompt = JSON.stringify(body, null, 2);
  const endpoint = `${BASE_URL.replace(/\/+$/, "")}/v1/chat/completions`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      temperature: 0.55
    })
  });

  const raw = await response.text();
  if (!response.ok) {
    sendJson(res, response.status, { error: "AI 服务调用失败" });
    return;
  }

  const data = safeJson(raw, {});
  const content = data?.choices?.[0]?.message?.content || "";
  const review = parseModelJson(content);

  if (!review) {
    sendJson(res, 502, { error: "AI 返回格式无法解析" });
    return;
  }

  sendJson(res, 200, { review });
}

function serveStatic(urlPath, res) {
  const safePath = path.normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, "");
  const requested = safePath === "/" ? "/index.html" : safePath;
  const filePath = path.join(publicDir, requested);

  if (!filePath.startsWith(publicDir)) {
    sendText(res, 403, "Forbidden");
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      sendText(res, 404, "Not found");
      return;
    }
    const type = mimeTypes[path.extname(filePath)] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type });
    res.end(content);
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", chunk => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        req.destroy();
        reject(new Error("Payload too large"));
      }
    });
    req.on("end", () => resolve(safeJson(raw, {})));
    req.on("error", reject);
  });
}

function parseModelJson(content) {
  const direct = safeJson(content, null);
  if (direct) return normalizeReview(direct);

  const match = content.match(/\{[\s\S]*\}/);
  if (!match) return null;
  const parsed = safeJson(match[0], null);
  return parsed ? normalizeReview(parsed) : null;
}

function normalizeReview(review) {
  return {
    diagnosisTitle: String(review.diagnosisTitle || "").slice(0, 80),
    diagnosisText: String(review.diagnosisText || "").slice(0, 500),
    focus: String(review.focus || "").slice(0, 20),
    bestVideo: normalizeTextField(review.bestVideo).slice(0, 240),
    weakVideo: normalizeTextField(review.weakVideo).slice(0, 240),
    suggestions: Array.isArray(review.suggestions) ? review.suggestions.slice(0, 8).map(item => ({
      label: String(item.label || "建议").slice(0, 20),
      text: String(item.text || "").slice(0, 360)
    })) : [],
    plan: Array.isArray(review.plan) ? review.plan.slice(0, 7).map((item, index) => ({
      day: String(item.day || `第 ${index + 1} 天`).slice(0, 20),
      text: String(item.text || "").slice(0, 260)
    })) : []
  };
}

function normalizeTextField(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    return [
      value.title,
      value.reason,
      value.analysis,
      value.text
    ].filter(Boolean).join("：") || JSON.stringify(value);
  }
  return String(value);
}

function safeJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function sendText(res, status, text) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

server.listen(PORT, () => {
  console.log(`CreatorInsight AI running at http://localhost:${PORT}`);
});
