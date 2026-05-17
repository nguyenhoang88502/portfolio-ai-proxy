import fs from 'fs';
import path from 'path';
import * as cheerio from 'cheerio';

let cachedPortfolioText = null;
let lastScrapeTime = 0;
const CACHE_LIFETIME = 3600000;

export default async function handler(request, response) {
  const allowedOrigin = process.env.ALLOWED_ORIGIN || 'https://nguyenhoang88502.github.io';
  response.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (request.method === 'OPTIONS') return response.status(200).end();
  if (request.method !== 'POST') return response.status(405).json({ error: 'Method not allowed' });

  try {
    const contextPath = path.resolve(process.cwd(), 'data', 'site-context.json');
    const siteContext = JSON.parse(fs.readFileSync(contextPath, 'utf8'));

    if (!cachedPortfolioText || Date.now() - lastScrapeTime > CACHE_LIFETIME) {
      console.log("Scraping fresh context from the live site...");
      const siteResponse = await fetch('https://nguyenhoang88502.github.io');
      const html = await siteResponse.text();
      const $ = cheerio.load(html);

      $('nav, script, style, footer').remove();

      const sectionsToScrape = ['#hero', '#Education', '#skills', '#experience', '#extra', '#projects'];
      let scrapedData = '';

      sectionsToScrape.forEach(id => {
        const sectionText = $(id).text().replace(/\s+/g, ' ').trim();
        if (sectionText) scrapedData += sectionText + '\n\n';
      });

      cachedPortfolioText = scrapedData;
      lastScrapeTime = Date.now();
    }

    const SYSTEM_PROMPT = `You are the AI assistant for ${siteContext.owner}'s portfolio.
    You have two sources of knowledge.

    SOURCE 1: DEEP PERSONAL & STRUCTURAL CONTEXT:
    ${JSON.stringify(siteContext)}

    SOURCE 2: LIVE WEBSITE TEXT (Up-to-date project and resume details):
    ${cachedPortfolioText}

    INSTRUCTIONS:
    - Base your answers on a combination of both sources.
    - Prioritize project discussions based on the 'projects_ordered_by_pride' list in Source 1.
    - If the user asks personal questions, weave in the hobbies, lifestyle, and relationship details from Source 1 naturally to humanize the response.
    - Provide detailed, professional answers.
    - Do not claim access to private systems or files.`;

    const { messages } = request.body;

    const deepseekResponse = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          ...messages
        ],
        max_tokens: 2000
      }),
    });

    const data = await deepseekResponse.json();
    return response.status(200).json({ text: data.choices[0].message.content });

  } catch (error) {
    console.error("Error in AI Proxy:", error);
    return response.status(500).json({ error: 'Internal Server Error' });
  }
}
