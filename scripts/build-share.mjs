/* ============================================================
   角色分享頁產生器（Netlify 部署時接在 build-images.mjs 後面自動執行）

   X、Plurk、Discord 這些平台抓連結預覽時不會執行網頁裡的程式，
   也看不到網址 # 後面的部分，所以 /#/char/xxx 這種網址分享出去，
   預覽永遠都是首頁。這支腳本會幫每個角色產生：

     dist/char/<角色id>/index.html  —— 只放這個角色的標題、簡介、預覽圖等
                                       分享用的資訊；真人打開時會立刻跳回
                                       原本的角色頁（/#/char/<角色id>）
     dist/share/<角色id>.jpg         —— 1200×630 的分享預覽圖：
                                       角色圖片完整置中，背景是同一張圖放大模糊

   另外也會重新產生 dist/sitemap.xml，把每個角色的分享頁都列進去。
   角色資料、圖片都從 characters-*.json 讀，後台新增角色後重新部署就會自動產生。
============================================================ */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DIST = path.join(ROOT, 'dist');
const CACHE = path.join(ROOT, 'node_modules', '.cache', 'monday-share');

/* 正式站用 Netlify 給的 URL；PR 預覽站用預覽網址，這樣在預覽站也能測試分享效果 */
const SITE = (
  (process.env.CONTEXT === 'production' ? process.env.URL : (process.env.DEPLOY_PRIME_URL || process.env.URL))
  || 'https://mondaysmood.netlify.app'
).replace(/\/$/, '');

const SITE_NAME = "Monday's Mood";
const DEFAULT_IMAGE = 'images/about-avatar.jpg';
const CARD_W = 1200, CARD_H = 630;
/* 調整分享圖的版面時，記得把 VERSION 加一，快取才會整批重新產生 */
const VERSION = 1;

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
/* 簡介裡可能有 <b> 之類的標籤跟換行，轉成一行純文字再截斷 */
function plainText(html, max){
  const t = String(html || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}
const localPath = src => src ? decodeURI(String(src).replace(/^\.?\//, '')) : '';

function loadCharacters(){
  const out = [];
  for(const file of fs.readdirSync(ROOT).filter(f => /^characters-.+\.json$/.test(f)).sort()){
    let data;
    try{ data = JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8')); }
    catch(err){ console.warn(`⚠ 無法讀取 ${file}：${err.message}`); continue; }
    const world = file.replace(/^characters-|\.json$/g, '');
    for(const ch of (Array.isArray(data) ? data : data.characters || [])){
      if(ch && ch.id) out.push({ ...ch, world: world === 'original' ? null : world });
    }
  }
  return out;
}

function loadWorldNames(){
  try{
    const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'worlds.json'), 'utf8'));
    return Object.fromEntries((data.worlds || []).map(w => [w.slug, w.name]));
  }catch{ return {}; }
}

/* 分享圖用哪張：大頭照 → 全身立繪 → 第一張 Gallery → 網站預設圖，取第一個真的存在的檔案 */
function pickImage(ch){
  const candidates = [ch.avatarImg, ch.fullbodyImg, ...(ch.gallery || []).filter(g => !g.sensitive).map(g => g.image || g.full || g.thumb), DEFAULT_IMAGE];
  for(const c of candidates){
    const p = localPath(c);
    if(p && fs.existsSync(path.join(ROOT, p))) return p;
  }
  return null;
}

async function makeCard(srcRel, destAbs){
  const buf = fs.readFileSync(path.join(ROOT, srcRel));
  const key = createHash('sha1').update(buf).digest('hex');
  const cached = path.join(CACHE, `${key}-v${VERSION}.jpg`);
  if(!fs.existsSync(cached)){
    const src = sharp(buf, { limitInputPixels:false }).rotate();
    /* 背景：同一張圖撐滿整張卡片、模糊、壓暗；前景：整張圖完整縮進卡片高度內置中，
       不管原圖是直的、橫的、方的，臉都不會被裁掉 */
    const bg = await src.clone().resize(CARD_W, CARD_H, { fit:'cover' }).blur(28).modulate({ brightness:0.55 }).toBuffer();
    const fg = await src.clone().resize(CARD_W - 80, CARD_H - 60, { fit:'inside', withoutEnlargement:false }).toBuffer();
    const meta = await sharp(fg).metadata();
    const card = await sharp(bg)
      .composite([{ input:fg, left:Math.round((CARD_W - meta.width)/2), top:Math.round((CARD_H - meta.height)/2) }])
      .flatten({ background:'#111' })
      .jpeg({ quality:84, mozjpeg:true })
      .toBuffer();
    fs.writeFileSync(cached, card);
  }
  fs.copyFileSync(cached, destAbs);
}

function sharePage(ch, worldName){
  const id = ch.id;
  const appUrl = `/#/char/${encodeURIComponent(id)}`;
  const pageUrl = `${SITE}/char/${encodeURIComponent(id)}/`;
  const imageUrl = `${SITE}/share/${encodeURIComponent(id)}.jpg`;
  const name = ch.codename || id;
  const title = `${name} — ${SITE_NAME}`;
  const tagline = [ch.role, ch.affiliation, worldName].filter(v => v && v !== '—').join('｜');
  const desc = plainText([tagline, ch.bio].filter(Boolean).join('　'), 110) || `${SITE_NAME} 角色檔案`;
  return `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${esc(pageUrl)}">
<meta property="og:type" content="profile">
<meta property="og:site_name" content="${esc(SITE_NAME)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(pageUrl)}">
<meta property="og:image" content="${esc(imageUrl)}">
<meta property="og:image:type" content="image/jpeg">
<meta property="og:image:width" content="${CARD_W}">
<meta property="og:image:height" content="${CARD_H}">
<meta property="og:image:alt" content="${esc(name)}">
<meta property="og:locale" content="zh_TW">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${esc(imageUrl)}">
<meta name="twitter:image:alt" content="${esc(name)}">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='16' fill='%23404aff'/%3E%3C/svg%3E">
<!-- 這頁只給分享預覽用；真人打開會立刻跳到網站裡的角色頁。
     不用 meta refresh，因為有些平台的爬蟲會跟著跳轉，就會抓到首頁的預覽 -->
<script>location.replace(${JSON.stringify(appUrl)});</script>
</head>
<body style="font-family:sans-serif;padding:40px;text-align:center;">
<p><a href="${esc(appUrl)}">${esc(name)} — ${esc(SITE_NAME)}</a></p>
</body>
</html>
`;
}

async function main(){
  const t0 = Date.now();
  if(!fs.existsSync(DIST)){ console.error('找不到 dist/，請先執行 build-images.mjs'); process.exit(1); }
  fs.mkdirSync(CACHE, { recursive:true });
  fs.mkdirSync(path.join(DIST, 'share'), { recursive:true });

  const worldNames = loadWorldNames();
  const chars = loadCharacters();
  const seen = new Set();
  let ok = 0;
  for(const ch of chars){
    if(seen.has(ch.id)){ console.warn(`⚠ 角色 id 重複，略過：${ch.id}`); continue; }
    seen.add(ch.id);
    if(/[\/\\]|^\.\.?$/.test(ch.id)){ console.warn(`⚠ 角色 id 不能當資料夾名稱，略過：${ch.id}`); continue; }
    try{
      const img = pickImage(ch);
      if(img) await makeCard(img, path.join(DIST, 'share', `${ch.id}.jpg`));
      const dir = path.join(DIST, 'char', ch.id);
      fs.mkdirSync(dir, { recursive:true });
      fs.writeFileSync(path.join(dir, 'index.html'), sharePage(ch, ch.world ? (worldNames[ch.world] || ch.world.toUpperCase()) : ''));
      ok++;
    }catch(err){
      /* 單一角色出錯不會讓整個部署失敗，只是那個角色沒有分享頁 */
      console.warn(`⚠ 無法產生 ${ch.id} 的分享頁：${err.message}`);
    }
  }

  /* sitemap：首頁＋每個角色的分享頁 */
  const today = new Date().toISOString().slice(0, 10);
  const urls = [`${SITE}/`, ...[...seen].map(id => `${SITE}/char/${encodeURIComponent(id)}/`)];
  fs.writeFileSync(path.join(DIST, 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls.map(u => `  <url><loc>${esc(u)}</loc><lastmod>${today}</lastmod></url>`).join('\n') +
    `\n</urlset>\n`);

  console.log(`分享頁產生完成：${ok} 個角色，網址開頭 ${SITE}，耗時 ${((Date.now()-t0)/1000).toFixed(1)} 秒`);
}

main().catch(err => { console.error(err); process.exit(1); });
