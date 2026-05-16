import fs from "fs";
import path from "path";

const DEFAULT_ALLOWED_ORIGIN = "https://nguyenhoang88502.github.io";
const DEFAULT_MODEL = "deepseek-v4-pro";
const MAX_MESSAGES = 16;
const MAX_MESSAGE_LENGTH = 3000;

function parseBody(request) {
  if (!request.body) return {};
  if (typeof request.body === "string") {
    return JSON.parse(request.body);
  }
  return request.body;
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES) {
    throw new Error("Invalid messages");
  }

  return messages.map((message) => {
    const role = message?.role === "assistant" ? "assistant" : "user";
    const content = String(message?.content || "").trim().slice(0, MAX_MESSAGE_LENGTH);

    if (!content) {
      throw new Error("Empty message");
    }

    return { role, content };
  });
}

function loadSiteContext() {
  const contextPath = path.resolve(process.cwd(), "data", "site-context.json");
  return JSON.parse(fs.readFileSync(contextPath, "utf8"));
}

function buildSystemPrompt(siteContext) {
  return [
    `You are the AI assistant for ${siteContext.owner}'s portfolio.`,
    `Role: ${siteContext.role}.`,
    `Core focus: ${siteContext.core_focus}`,
    `Key projects and tools: ${JSON.stringify(siteContext.key_tools)}.`,
    `Other projects: ${JSON.stringify(siteContext.other_projects)}.`,
    `Contact: ${JSON.stringify(siteContext.contact)}.`,
    "Be concise, professional, and helpful.",
    "Do not invent credentials, private details, or live system access.",
    "When useful, mention the exact project folder or page a visitor should open."
  ].join("\n");
}

export default async function handler(request, response) {
  const allowedOrigin = process.env.ALLOWED_ORIGIN || DEFAULT_ALLOWED_ORIGIN;
  const origin = request.headers.origin;

  response.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  response.setHeader("Vary", "Origin");

  if (request.method === "OPTIONS") {
    return response.status(200).end();
  }

  if (origin && origin !== allowedOrigin) {
    return response.status(403).json({ error: "Origin not allowed" });
  }

  if (request.method !== "POST") {
    response.setHeader("Allow", "POST, OPTIONS");
    return response.status(405).json({ error: "Method not allowed" });
  }

  if (!process.env.DEEPSEEK_API_KEY) {
    return response.status(500).json({ error: "DeepSeek API key is not configured" });
  }

  try {
    const body = parseBody(request);
    const messages = normalizeMessages(body.messages);
    const siteContext = loadSiteContext();
    const systemPrompt = buildSystemPrompt(siteContext);

    const deepseekResponse = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`
      },
      body: JSON.stringify({
        model: process.env.DEEPSEEK_MODEL || DEFAULT_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          ...messages
        ],
        max_tokens: 500,
        temperature: 0.4
      })
    });

    const data = await deepseekResponse.json();

    if (!deepseekResponse.ok) {
      return response.status(deepseekResponse.status).json({
        error: data?.error?.message || "DeepSeek request failed"
      });
    }

    const text = data?.choices?.[0]?.message?.content || "";
    return response.status(200).json({ text });
  } catch (error) {
    console.error(error);
    const status = error.message === "Invalid messages" || error.message === "Empty message" ? 400 : 500;
    return response.status(status).json({
      error: status === 400 ? error.message : "Internal Server Error"
    });
  }
}
