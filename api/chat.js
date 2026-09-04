/**
 * POST /api/chat  { messages: [...], app?: "portfolio" | "saigon" }
 *
 * Two front-ends share this endpoint and the same origin
 * (nguyenhoang88502.github.io), so the system prompt is chosen from the `app`
 * field, falling back to the Referer path. Ticket-book specific work
 * (normalising input, geocoding, ranking places) lives in /api/bucketlist.
 */

import fs from 'fs';
import path from 'path';
import * as cheerio from 'cheerio';

import {
  applyCors,
  callDeepSeek,
  resolveApp,
  sanitizeMessages,
  fail,
} from './_shared.js';

let cachedPortfolioText = null;
let lastScrapeTime = 0;
const CACHE_LIFETIME = 3600000;

async function portfolioSystemPrompt() {
  const contextPath = path.resolve(process.cwd(), 'data', 'site-context.json');
  const siteContext = JSON.parse(fs.readFileSync(contextPath, 'utf8'));

  if (!cachedPortfolioText || Date.now() - lastScrapeTime > CACHE_LIFETIME) {
    try {
      const siteResponse = await fetch('https://nguyenhoang88502.github.io');
      const html = await siteResponse.text();
      const $ = cheerio.load(html);
      $('nav, script, style, footer').remove();

      const sectionsToScrape = ['#hero', '#Education', '#skills', '#experience', '#extra', '#projects'];
      let scrapedData = '';
      sectionsToScrape.forEach((id) => {
        const sectionText = $(id).text().replace(/\s+/g, ' ').trim();
        if (sectionText) scrapedData += sectionText + '\n\n';
      });

      cachedPortfolioText = scrapedData;
      lastScrapeTime = Date.now();
    } catch (err) {
      // A scrape failure should degrade to the static context, not 500 the request.
      console.error('[proxy] portfolio scrape failed:', err?.message || err);
      cachedPortfolioText = cachedPortfolioText || '';
    }
  }

  return `You are the AI assistant for ${siteContext.owner}'s portfolio.
    You have two sources of knowledge.

    SOURCE 1: DEEP PERSONAL & STRUCTURAL CONTEXT:
    ${JSON.stringify(siteContext)}

    SOURCE 2: LIVE WEBSITE TEXT (Up-to-date project and resume details):
    ${cachedPortfolioText}

    INSTRUCTIONS:
    - Base your answers on a combination of both sources.
    - Follow the public project order and the privacy_and_claim_rules in Source 1.
    - When discussing carton-fit impact, explain the operator-downtime and technician-time calculations separately.
    - Provide detailed, professional answers.
    - Do not claim access to private systems or files, and do not infer private or confidential details.`;
}

function bucketlistSystemPrompt(places) {
  return [
    'Bạn là trợ lý của "Sổ Vé" — sổ tay những chỗ đáng ghé ở Sài Gòn.',
    'Giúp người dùng chọn chỗ đi chơi theo tâm trạng, nhóm hoạt động và khoảng cách.',
    'Trả lời bằng tiếng Việt, ngắn gọn, thân thiện, gợi ý cụ thể chứ đừng nói chung chung.',
    'Chỉ nói về những chỗ có trong sổ dưới đây; không bịa địa chỉ hay địa điểm mới.',
    'Nếu không có chỗ nào hợp, nói thẳng và gợi ý nới bớt điều kiện.',
    '',
    `Sổ vé hiện có ${places.length} chỗ:`,
    JSON.stringify(places),
  ].join('\n');
}

export default async function handler(request, response) {
  if (applyCors(request, response)) return;

  try {
    const body = request.body && typeof request.body === 'object' ? request.body : {};
    const messages = sanitizeMessages(body.messages);
    if (!messages.length) return fail(response, 400, 'no_messages');

    const app = resolveApp(request);
    const system = app === 'saigon'
      ? bucketlistSystemPrompt(
          (Array.isArray(body.places) ? body.places : []).slice(0, 120).map((p) => ({
            ten: String(p.ten || '').slice(0, 90),
            category: p.category,
            mood: p.mood,
            diachi: String(p.diachi || '').slice(0, 90),
            daDi: !!p.daDi,
          }))
        )
      : await portfolioSystemPrompt();

    const text = await callDeepSeek({
      system,
      messages,
      maxTokens: app === 'saigon' ? 1200 : 2000,
    });

    return response.status(200).json({ text });
  } catch (error) {
    const msg = String(error?.message || error);
    if (msg === 'missing_api_key') return fail(response, 500, 'ai_not_configured', msg);
    return fail(response, 502, 'upstream_failed', msg);
  }
}
