import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, 'public');

const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const rawLine of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '');
    if (!(key in process.env)) process.env[key] = value;
  }
}

const port = Number(process.env.PORT) || 3000;
const model = process.env.OPENROUTER_MODEL || 'openrouter/auto';
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 50_000) reject(new Error('Request too large.'));
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function extractJson(text) {
  const cleaned = text.trim().replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('The AI returned malformed slop. Try again.');
  return JSON.parse(cleaned.slice(start, end + 1));
}

async function validateIdea(req, res) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return sendJson(res, 500, { error: 'OPENROUTER_API_KEY is missing. Copy .env.example to .env and add your key.' });

  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: 'Invalid request body.' });
  }

  const idea = String(payload.idea || '').trim();
  if (idea.length < 20) return sendJson(res, 400, { error: 'Give the oracle at least 20 characters of startup vision.' });

  const prompt = `You are VibeScore AI, a satirical but useful startup evaluator. Analyze the idea below. Be concise, specific, witty, and honest. Brutality: ${payload.brutality || 'balanced'}.

Idea: ${idea}
Audience: ${payload.audience || 'not specified'}
Business model: ${payload.businessModel || 'not specified'}

Return only valid JSON with this exact shape:
{"name":"string","tagline":"string","vibeScore":0,"marketNeed":0,"slopRisk":0,"buildDifficulty":0,"verdict":"string","strongestAngle":"string","biggestProblem":"string","unfairAdvantages":["string","string","string"],"features":["string","string","string","string"],"nextSteps":["string","string","string"],"roast":"string"}
All scores must be integers from 0 to 100.`;

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.SITE_URL || `http://localhost:${port}`,
        'X-Title': 'SlopGPT VibeScore AI'
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: 'Return only valid JSON. Do not use markdown.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.8
      })
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data?.error?.message || 'OpenRouter rejected the request.');
    const text = data?.choices?.[0]?.message?.content;
    if (!text) throw new Error('The AI returned an empty response.');
    sendJson(res, 200, { result: extractJson(text), model: data.model || model });
  } catch (error) {
    sendJson(res, 502, { error: error instanceof Error ? error.message : 'The disruption pipeline failed.' });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'POST' && url.pathname === '/api/validate') return validateIdea(req, res);
  if (req.method === 'GET' && url.pathname === '/api/health') return sendJson(res, 200, { ok: true, model });

  const requested = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = path.normalize(path.join(publicDir, requested));
  if (!filePath.startsWith(publicDir)) return sendJson(res, 403, { error: 'Forbidden.' });

  fs.readFile(filePath, (error, content) => {
    if (error) {
      if (error.code === 'ENOENT') {
        fs.readFile(path.join(publicDir, 'index.html'), (fallbackError, fallback) => {
          if (fallbackError) return sendJson(res, 404, { error: 'Not found.' });
          res.writeHead(200, { 'Content-Type': mime['.html'] });
          res.end(fallback);
        });
        return;
      }
      return sendJson(res, 500, { error: 'Could not load the file.' });
    }
    res.writeHead(200, { 'Content-Type': mime[path.extname(filePath)] || 'application/octet-stream' });
    res.end(content);
  });
});

server.listen(port, '0.0.0.0', () => {
  console.log(`✨ SlopGPT running at http://localhost:${port}`);
});
