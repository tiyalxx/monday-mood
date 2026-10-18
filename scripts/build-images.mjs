/* ============================================================
   網站建置腳本（Netlify 部署時自動執行：npm run build）
   1. 把整個網站複製到 dist/（Netlify 實際發布的資料夾）
   2. 幫 images/、gate-art/ 底下每一張 jpg/png 產生兩個壓縮版本：
        dist/_img/thumb/<原路徑>.webp  —— 縮圖（短邊 600px），給 Gallery 縮圖、頭像、角色卡片用
        dist/_img/large/<原路徑>.webp  —— 大圖（長邊最多 2400px），給燈箱、全身立繪、首頁大圖用
   3. 寫出 dist/_img/manifest.json，列出有成功產生壓縮版的圖片，
      index.html 會讀這份清單，清單裡有的圖才改用壓縮版，沒有的照舊用原圖。

   原圖完全不會被修改，也照樣會發布（萬一壓縮版有問題，網頁會自動退回原圖）。
   壓縮結果會依圖片內容存一份快取在 node_modules/.cache/ 裡，
   Netlify 部署之間會保留這個資料夾，所以只有新上傳／換掉的圖需要重新壓縮。
============================================================ */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DIST = path.join(ROOT, 'dist');
const CACHE = path.join(ROOT, 'node_modules', '.cache', 'monday-images');

const IMAGE_DIRS = ['images', 'gate-art'];
const IMAGE_EXT = /\.(jpe?g|png|webp)$/i;

/* 調整尺寸或畫質時，記得把 VERSION 加一，快取才會整批重新產生 */
const VERSION = 1;
const VARIANTS = {
  thumb: img => img.resize(600, 600, { fit: 'outside', withoutEnlargement: true }).webp({ quality: 80 }),
  large: img => img.resize(2400, 2400, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }),
};
/* 首頁滿版大圖（gate-art/ 和 gate.json 裡列的圖）另外多做一個高畫質版：
   長邊最多 3600px、畫質 90，給高解析度螢幕（筆電、手機）滿版顯示時才不會糊 */
const HERO_VARIANT = img => img.resize(3600, 3600, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 90 });
function heroImageSet(){
  const set = new Set();
  try{
    const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'gate.json'), 'utf8'));
    for(const s of data.slides || []) for(const src of [s.image, s.mobileImage]){
      if(!src) continue;
      let rel = String(src).replace(/^\.?\//, '');
      try{ rel = decodeURI(rel); }catch{}
      set.add(rel);
    }
  }catch{}
  return set;
}
const HERO_IMAGES = heroImageSet();
const isHero = rel => rel.startsWith('gate-art/') || HERO_IMAGES.has(rel);

/* 不需要發布到網站上的檔案／資料夾 */
const SKIP_COPY = new Set(['.git', '.github', 'node_modules', 'dist', 'scripts', 'package.json', 'package-lock.json', 'netlify.toml', '.gitignore']);

function listImages(dir){
  const out = [];
  const abs = path.join(ROOT, dir);
  if(!fs.existsSync(abs)) return out;
  for(const ent of fs.readdirSync(abs, { withFileTypes:true, recursive:true })){
    if(!ent.isFile() || !IMAGE_EXT.test(ent.name)) continue;
    const full = path.join(ent.parentPath ?? ent.path, ent.name);
    out.push(path.relative(ROOT, full).split(path.sep).join('/'));
  }
  return out;
}

async function processImage(rel){
  const buf = fs.readFileSync(path.join(ROOT, rel));
  const hash = createHash('sha1').update(buf).digest('hex');
  const variants = isHero(rel) ? { ...VARIANTS, hero: HERO_VARIANT } : VARIANTS;
  for(const [name, apply] of Object.entries(variants)){
    const cached = path.join(CACHE, `${hash}-${name}-v${VERSION}.webp`);
    if(!fs.existsSync(cached)){
      /* rotate() 依照相機的 EXIF 方向資訊把圖轉正，不然手機拍的照片可能會躺著 */
      const data = await apply(sharp(buf, { limitInputPixels:false }).rotate()).toBuffer();
      fs.writeFileSync(cached, data);
    }
    const dest = path.join(DIST, '_img', name, rel + '.webp');
    fs.mkdirSync(path.dirname(dest), { recursive:true });
    fs.copyFileSync(cached, dest);
  }
  return buf.length;
}

async function main(){
  const t0 = Date.now();
  fs.rmSync(DIST, { recursive:true, force:true });
  fs.mkdirSync(DIST, { recursive:true });
  fs.mkdirSync(CACHE, { recursive:true });

  for(const name of fs.readdirSync(ROOT)){
    if(SKIP_COPY.has(name)) continue;
    fs.cpSync(path.join(ROOT, name), path.join(DIST, name), { recursive:true });
  }

  const images = IMAGE_DIRS.flatMap(listImages);
  const done = [];
  const failed = [];
  let inputBytes = 0;
  /* 同時處理幾張圖：太多會吃光 Netlify 建置機的記憶體（大張 PNG 解碼後很佔空間） */
  const concurrency = Math.max(1, Math.min(4, os.availableParallelism?.() ?? 2));
  sharp.concurrency(1);
  let next = 0;
  await Promise.all(Array.from({ length:concurrency }, async ()=>{
    while(next < images.length){
      const rel = images[next++];
      try{
        const bytes = await processImage(rel);
        inputBytes += bytes;
        done.push(rel);
      }catch(err){
        /* 單張圖壞掉不會讓整個部署失敗，那張圖會繼續用原圖顯示 */
        failed.push(rel);
        console.warn(`⚠ 無法壓縮 ${rel}：${err.message}`);
      }
    }
  }));

  done.sort();
  fs.writeFileSync(path.join(DIST, '_img', 'manifest.json'), JSON.stringify({ version:VERSION, images:done, hero:done.filter(isHero) }));

  const sizeOf = dir => {
    let total = 0;
    const abs = path.join(DIST, '_img', dir);
    if(!fs.existsSync(abs)) return 0;
    for(const ent of fs.readdirSync(abs, { withFileTypes:true, recursive:true })){
      if(ent.isFile()) total += fs.statSync(path.join(ent.parentPath ?? ent.path, ent.name)).size;
    }
    return total;
  };
  const mb = n => (n / 1024 / 1024).toFixed(1) + ' MB';
  console.log(`圖片處理完成：${done.length} 張成功、${failed.length} 張失敗，耗時 ${((Date.now()-t0)/1000).toFixed(1)} 秒`);
  console.log(`  原圖合計 ${mb(inputBytes)} → 縮圖合計 ${mb(sizeOf('thumb'))}、大圖合計 ${mb(sizeOf('large'))}`);
}

main().catch(err=>{ console.error(err); process.exit(1); });
