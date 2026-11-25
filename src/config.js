// 读取 .env（零依赖），环境变量优先于 .env 文件
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadDotEnv() {
  const p = path.join(root, '.env');
  if (!fs.existsSync(p)) return {};
  const out = {};
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const i = t.indexOf('=');
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

const fileEnv = loadDotEnv();
const get = (k, d = '') => (process.env[k] ?? fileEnv[k] ?? d);

export const config = {
  root,
  port: Number(get('PORT', '8787')),
  fuyao: {
    apiKey: get('FUYAO_API_KEY'),
    baseUrl: get('FUYAO_BASE_URL', 'https://fuyao.aicubes.cn'),
  },
  llm: {
    apiKey: get('LLM_API_KEY'),
    baseUrl: get('LLM_BASE_URL', 'https://api.deepseek.com'),
    model: get('LLM_MODEL', 'deepseek-chat'),
  },
};
