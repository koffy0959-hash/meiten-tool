// 名店検索ツール・補助サーバー
// このサーバーはGoogle APIキーを一切持ちません。行うのは次の2つだけです：
//  1) publicフォルダの画面ファイルを配信する
//  2) 公式サイトの技術的な診断（スマホ対応か・httpsか・更新が古そうかを機械的にチェック）
// 店舗の検索（Google Places API・Googleカスタム検索API）は、利用者自身のブラウザから、
// 利用者自身のAPIキーで直接Googleへ問い合わせます。そのため、このサーバーを動かす人にも、
// 他の利用者にも、Google側の利用料はかかりません（かかるのは検索する本人のAPI利用分だけです）。
// 起動: node server.js  →  http://localhost:3000
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

let ENV_FILE = null;
(function loadEnv() {
  for (const name of ['.env', '.env.txt']) {
    const p = path.join(__dirname, name);
    if (!fs.existsSync(p)) continue;
    ENV_FILE = name;
    const text = fs.readFileSync(p, 'utf8').replace(/^﻿/, '');
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
    }
    return;
  }
})();

const PORT = Number(process.env.PORT || 3000);
const APP_VERSION = '2.0.0';

// 任意：画面を開く前にID・パスワードを求める（社外に公開するとき、閲覧を制限したい場合のみ）
const AUTH_USER = process.env.AUTH_USER || '';
const AUTH_PASS = process.env.AUTH_PASS || '';
const AUTH_ENABLED = !!(AUTH_USER && AUTH_PASS);
function checkAuth(req) {
  if (!AUTH_ENABLED) return true;
  const h = req.headers['authorization'] || '';
  if (!h.startsWith('Basic ')) return false;
  const [u, p] = Buffer.from(h.slice(6), 'base64').toString('utf8').split(':');
  return u === AUTH_USER && p === AUTH_PASS;
}

// 簡易レート制限（Google APIの費用とは無関係。サーバーへの過剰アクセス・悪用対策）
const RATE_LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN || 30);
const rateMap = new Map(); // ip -> { windowStart, count }
function checkRateLimit(ip) {
  const now = Date.now();
  const rec = rateMap.get(ip);
  if (!rec || now - rec.windowStart > 60000) { rateMap.set(ip, { windowStart: now, count: 1 }); return true; }
  rec.count++;
  return rec.count <= RATE_LIMIT_PER_MIN;
}

// ---------- 公式サイトの簡易診断（実際にサイトを取得して機械的にチェック。中身の良し悪しはAIで判断しません） ----------
async function auditSite(url) {
  const out = { reachable: false, https: false, mobile_friendly: null, has_reservation_hint: null, newest_year: null, issues: [] };
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 6000);
    const res = await fetch(url, { redirect: 'follow', signal: ctl.signal, headers: { 'user-agent': 'Mozilla/5.0 (compatible; MeitenCheck/1.0)' } });
    clearTimeout(t);
    out.reachable = res.ok;
    out.https = String(res.url || url).startsWith('https:');
    if (!out.https) out.issues.push('httpsに対応していない（http のまま）');
    const html = await res.text();
    out.mobile_friendly = /<meta[^>]+name=["']viewport["']/i.test(html);
    if (!out.mobile_friendly) out.issues.push('スマートフォン表示（viewportタグ）が見つからない');
    out.has_reservation_hint = /(予約|tel:|お問い合わせ|contact)/i.test(html);
    if (!out.has_reservation_hint) out.issues.push('予約・問い合わせの導線が見当たらない');
    const years = Array.from(html.matchAll(/(19|20)\d{2}/g)).map(m => Number(m[0])).filter(y => y >= 1995 && y <= new Date().getFullYear());
    if (years.length) out.newest_year = Math.max(...years);
    const curYear = new Date().getFullYear();
    if (out.newest_year && curYear - out.newest_year >= 3) out.issues.push(`サイト内の年表記が${out.newest_year}年までで、更新が止まっている可能性`);
  } catch (e) {
    out.reachable = false;
    out.issues.push('サイトに接続できなかった（閉鎖・移転・一時的な不具合の可能性）');
  }
  return out;
}

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 200000) { reject(new Error('リクエストが大きすぎます')); req.destroy(); } });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { reject(new Error('JSONが不正です')); } });
  });
}
function isHttpUrl(u) { try { const x = new URL(String(u)); return x.protocol === 'http:' || x.protocol === 'https:'; } catch { return false; } }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const ip = req.socket.remoteAddress || 'unknown';
  try {
    if (AUTH_ENABLED && !checkAuth(req)) {
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'www-authenticate': 'Basic realm="meiten-search-tool"' });
      return res.end('IDとパスワードが必要です / Authentication required');
    }
    if (req.method === 'GET' && url.pathname === '/api/status') {
      return send(res, 200, { env_file: ENV_FILE, node: process.version, version: APP_VERSION, auth: AUTH_ENABLED });
    }
    if (req.method === 'POST' && url.pathname === '/api/audit-site') {
      if (!checkRateLimit(ip)) throw new Error('リクエストが多すぎます。少し時間を置いてから再度お試しください。');
      const input = await readBody(req);
      if (!isHttpUrl(input.url)) throw new Error('URLが不正です');
      const out = await auditSite(input.url);
      return send(res, 200, out);
    }
    if (req.method === 'GET') {
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const p = path.join(__dirname, 'public', path.normalize(file).replace(/^(\.\.[\/\\])+/, ''));
      if (p.startsWith(path.join(__dirname, 'public')) && fs.existsSync(p) && fs.statSync(p).isFile()) {
        const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
        return send(res, 200, fs.readFileSync(p), types[path.extname(p)] || 'application/octet-stream');
      }
    }
    send(res, 404, { error: 'Not found' });
  } catch (e) {
    console.error(`\n[エラー] ${new Date().toLocaleTimeString('ja-JP')} ${url.pathname}\n${e.message || e}\n`);
    send(res, 500, { error: e.message || String(e) });
  }
});

if (require.main === module) {
  if (Number(process.versions.node.split('.')[0]) < 18) {
    console.log(`\n[エラー] Node.js のバージョンが古いです（${process.version}）。https://nodejs.org/ja から LTS 版を入れ直してください。\n`);
    process.exit(1);
  }
  server.on('error', e => {
    if (e.code === 'EADDRINUSE') {
      console.log(`\n[エラー] ポート ${PORT} は既に使われています。.env に PORT=3001 のように書き足してください。\n`);
    } else console.log('\n[エラー] サーバーを起動できませんでした: ' + e.message + '\n');
    process.exit(1);
  });
  server.listen(PORT, () => {
    const url = `http://localhost:${PORT}`;
    console.log('');
    console.log('  ==============================================');
    console.log('   名店検索ツール  起動しました（v' + APP_VERSION + '）');
    console.log('   ブラウザで開くアドレス:  ' + url);
    console.log('  ==============================================');
    console.log('   設定ファイル   : ' + (ENV_FILE || '見つかりません（.env がありません。なくても動きます）'));
    console.log('   アクセス制限   : ' + (AUTH_ENABLED ? 'あり（ID・パスワードを設定済み）' : 'なし'));
    console.log('   このサーバーはGoogle APIキーを持ちません。検索は各利用者のブラウザから直接Googleへ行われます。');
    console.log('');
    console.log('   ※ この黒い画面は閉じないでください。');
    console.log('   ※ 終了するときは Ctrl キーを押しながら C を押します。');
    console.log('');
    if (process.env.OPEN_BROWSER === '1' && process.platform === 'win32') {
      require('child_process').exec(`start "" "${url}"`);
    }
  });
}
module.exports = { auditSite };
