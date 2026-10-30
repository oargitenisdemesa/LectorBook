'use strict';
/* Lector de textos en cualquier formato: ePub, txt, md, html, docx, odt, rtf, pdf.
   Todos devuelven lo mismo: { title, author, language, cover, chapters:[{title, blocks, chars}] } */
const Docs = (() => {
  const MAX_PART = 14000;
  const PDFJS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/';
  const td = new TextDecoder('utf-8');
  const byLocal = (root, name) => [...root.getElementsByTagName('*')].filter(e => e.localName === name);
  const parseXml = (t, type = 'application/xml') => new DOMParser().parseFromString(t, type);
  const stripName = n => n.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim();

  /* ---------- texto plano ---------- */
  function decodeText(bytes) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, ''); }
    catch (e) { return new TextDecoder('windows-1252').decode(bytes); }
  }
  const HEADRE = /^(cap[ií]tulo|chapter|parte|part|libro|book|pr[oó]logo|ep[ií]logo|pre[aá]mbulo|introducci[oó]n|prologue|epilogue|preface|introduction)\b[^.!?]{0,70}$|^[IVXLC]{1,7}\.?$/i;
  function cleanMd(t) {
    return t.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/<[^>]+>/g, '').replace(/(\*\*|__)/g, '')
      .replace(/\*([^*\s][^*]*?)\*/g, '\uE000$1\uE001').replace(/(^|[\s(])_([^_\s][^_]*?)_(?=[\s.,;:!?)]|$)/g, '$1\uE000$2\uE001')
      .replace(/[*`~]/g, '').replace(/^>+\s*/, '')
      .replace(/^([-+*]|\d+[.)])\s+/, '').trim();
  }
  function textToBlocks(text, md) {
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    const hasBlank = /\n\s*\n/.test(text.replace(/\r\n?/g, '\n'));
    const blocks = []; let para = [], fence = false;
    const flush = () => { if (para.length) { const t = para.join(' ').replace(/\s+/g, ' ').trim(); if (t) blocks.push({ text: t, kind: 'p' }); para = []; } };
    for (const raw of lines) {
      const line = raw.trim();
      if (md && /^(```|~~~)/.test(line)) { fence = !fence; flush(); continue; }
      if (fence) continue;
      if (!line) { flush(); continue; }
      let m;
      if (md && (m = /^(#{1,6})\s+(.*?)\s*#*$/.exec(line))) { flush(); const t = cleanMd(m[2]); if (t) blocks.push({ text: t, kind: 'h', level: m[1].length }); continue; }
      if (md && /^(-{3,}|\*{3,}|_{3,}|\|?[-: |]+\|)$/.test(line)) { flush(); continue; }
      if (line.length <= 80 && HEADRE.test(line)) { flush(); blocks.push({ text: line, kind: 'h', level: 1 }); continue; }
      const t = md ? cleanMd(line) : line;
      if (hasBlank) para.push(t); else { flush(); if (t) blocks.push({ text: t, kind: 'p' }); }
    }
    flush();
    return blocks;
  }

  /* ---------- bloques -> capítulos ---------- */
  function splitBig(blocks) {
    const out = [];
    for (const b of blocks) {
      if (b.kind !== 'p' || b.text.length <= 3000) { out.push(b); continue; }
      const sents = b.text.match(/[^.!?]+(?:[.!?]+["'»”)\]]*|$)\s*/g) || [b.text];
      let cur = '';
      for (const s of sents) { if (cur && (cur + s).length > 1500) { out.push({ text: cur.trim(), kind: 'p', cont: true }); cur = ''; } cur += s; }
      if (cur.trim()) out.push({ text: cur.trim(), kind: 'p', cont: true });
    }
    return out;
  }
  const sum = bl => bl.reduce((s, b) => s + b.text.length, 0);

  function chapterize(blocksIn, name) {
    const blocks = splitBig(blocksIn);
    // los capítulos empiezan en los títulos del nivel más alto que aparezca al menos dos veces
    const levels = blocks.filter(b => b.kind === 'h').map(b => b.level || 1);
    let top = 0;
    for (let L = 1; L <= 6 && !top; L++) if (levels.filter(x => x <= L).length >= 2) top = L;
    let chapters = [];
    for (const b of blocks) {
      if (top && b.kind === 'h' && (b.level || 1) <= top) chapters.push({ title: b.text.replace(/[\uE000\uE001]/g, '').slice(0, 90), blocks: [b] });
      else { if (!chapters.length) chapters.push({ title: 'Inicio', blocks: [] }); chapters[chapters.length - 1].blocks.push(b); }
    }
    // los capítulos casi vacíos (portada, un título suelto) se unen al siguiente
    for (let i = 0; i < chapters.length - 1;) {
      if (sum(chapters[i].blocks) < 150) { chapters[i + 1].blocks = chapters[i].blocks.concat(chapters[i + 1].blocks); chapters.splice(i, 1); } else i++;
    }
    // los capítulos enormes se parten en partes
    const out = [];
    for (const ch of chapters) {
      if (sum(ch.blocks) <= MAX_PART * 1.3) { out.push(ch); continue; }
      let part = [], acc = 0, k = 1;
      const base = chapters.length > 1 ? ch.title : (name || 'Texto');
      const push = () => { if (part.length) out.push({ title: `${base} · parte ${k++}`, blocks: part }); part = []; acc = 0; };
      for (const b of ch.blocks) { if (acc + b.text.length > MAX_PART && acc > 0) push(); part.push(b); acc += b.text.length; }
      push();
    }
    if (out.length === 1 && out[0].title === 'Inicio') out[0].title = name || 'Texto';
    return out.map(c => ({ title: c.title, blocks: c.blocks, chars: sum(c.blocks) }));
  }

  /* ---------- idioma (aviso si no es español) ---------- */
  const ES = new Set('el la los las de del que y en un una es se no por con para su al lo como más pero sus le ya o este sí porque esta entre cuando muy sin sobre también me hasta hay donde quien desde todo nos durante todos uno les ni contra otros ese eso ante ellos e esto mí antes algunos qué unos yo otro otras otra él tanto esa estos mucho quienes nada muchos cual poco ella estar estas algunas algo nosotros'.split(' '));
  const EN = new Set('the of and to in is that it was for on are as with his they be at one have this from or had by hot but some what there we can out other were all your when up use word how said an each she which do their time if will way about many then them would write like so these her long make thing see him two has look more day could go come did my sound no most number who over know water than call first people may down side been now find'.split(' '));
  function guessLang(text) {
    const words = text.slice(0, 20000).toLowerCase().match(/\p{L}+/gu) || [];
    let es = 0, en = 0;
    for (const w of words) { if (ES.has(w)) es++; if (EN.has(w)) en++; }
    if (es + en < 20) return '';
    return es >= en * 1.2 ? 'es' : en > es * 1.2 ? 'en' : '';
  }

  /* ---------- HTML ---------- */
  function htmlToDoc(text, name) {
    const blocks = Epub.blocksFromXhtml(text);
    const doc = parseXml(text, 'text/html');
    const t = (doc.querySelector('title') || {}).textContent;
    const a = doc.querySelector('meta[name=author]');
    return { title: (t && t.trim()) || name, author: a ? a.getAttribute('content') : '', blocks };
  }

  /* ---------- DOCX ---------- */
  async function docxToDoc(file, name) {
    const zip = await Epub.readZip(file);
    const body = await zip.get('word/document.xml');
    if (!body) throw new Error('Este archivo no parece un documento Word (.docx).');
    const styleNames = {};
    const st = await zip.get('word/styles.xml');
    if (st) for (const s of byLocal(parseXml(td.decode(st)), 'style')) {
      const nm = byLocal(s, 'name')[0];
      if (nm) styleNames[s.getAttribute('w:styleId')] = nm.getAttribute('w:val') || '';
    }
    const xml = parseXml(td.decode(body));
    const blocks = [];
    for (const p of byLocal(xml, 'p')) {
      const ps = byLocal(p, 'pStyle')[0];
      const sid = ps ? ps.getAttribute('w:val') : '';
      const sname = (styleNames[sid] || sid || '').toLowerCase();
      let text = '';
      for (const r of p.getElementsByTagName('*')) {
        if (r.localName !== 'r') continue;
        const iEl = byLocal(r, 'i')[0];
        const it = iEl && !/^(0|false)$/.test(iEl.getAttribute('w:val') || '1');
        let rt = '';
        for (const n of r.getElementsByTagName('*')) {
          if (n.localName === 't') rt += n.textContent;
          else if (n.localName === 'tab' || n.localName === 'br') rt += ' ';
        }
        text += it && rt.trim() ? '\uE000' + rt + '\uE001' : rt;
      }
      text = text.replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const m = /^(?:heading|t[ií]tulo|titre|[uü]berschrift|title)\s*(\d)?/.exec(sname);
      if (m) blocks.push({ text, kind: 'h', level: m[1] ? +m[1] : 1 }); else blocks.push({ text, kind: 'p' });
    }
    let title = name, author = '';
    const core = await zip.get('docProps/core.xml');
    if (core) {
      const c = parseXml(td.decode(core));
      const t = byLocal(c, 'title')[0], a = byLocal(c, 'creator')[0];
      if (t && t.textContent.trim()) title = t.textContent.trim();
      if (a) author = a.textContent.trim();
    }
    return { title, author, blocks };
  }

  /* ---------- ODT ---------- */
  async function odtToDoc(file, name) {
    const zip = await Epub.readZip(file);
    const body = await zip.get('content.xml');
    if (!body) throw new Error('Este archivo no parece un documento de OpenDocument (.odt).');
    const xml = parseXml(td.decode(body));
    const blocks = [];
    for (const n of xml.getElementsByTagName('*')) {
      if (n.localName !== 'h' && n.localName !== 'p') continue;
      let text = '';
      (function walk(e) {
        for (const c of e.childNodes) {
          if (c.nodeType === 3) text += c.nodeValue;
          else if (c.localName === 's' || c.localName === 'tab' || c.localName === 'line-break') text += ' ';
          else if (c.nodeType === 1) walk(c);
        }
      })(n);
      text = text.replace(/\s+/g, ' ').trim();
      if (!text) continue;
      if (n.localName === 'h') blocks.push({ text, kind: 'h', level: +n.getAttribute('text:outline-level') || 1 });
      else blocks.push({ text, kind: 'p' });
    }
    return { title: name, author: '', blocks };
  }

  /* ---------- RTF ---------- */
  function rtfToText(r) {
    const SKIP = new Set(['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'header', 'footer', 'footnote', 'generator', 'themedata', 'datastore', 'latentstyles', 'listtable', 'listoverridetable', 'rsidtbl']);
    let out = '', i = 0, depth = 0, skipAt = -1, uc = 1, pending = 0;
    const stack = [];
    const dec = new TextDecoder('windows-1252');
    while (i < r.length) {
      const c = r[i];
      if (c === '{') { stack.push(uc); depth++; i++; continue; }
      if (c === '}') { if (skipAt === depth) skipAt = -1; uc = stack.pop() ?? 1; depth--; i++; continue; }
      if (c === '\\') {
        const n = r[i + 1];
        if (n === '\\' || n === '{' || n === '}') { if (skipAt < 0) out += n; i += 2; continue; }
        if (n === '*') { if (skipAt < 0) skipAt = depth; i += 2; continue; }
        if (n === "'") { const h = parseInt(r.substr(i + 2, 2), 16); if (skipAt < 0 && !pending) out += dec.decode(new Uint8Array([h])); else if (pending) pending--; i += 4; continue; }
        const m = /^\\([a-zA-Z]+)(-?\d+)? ?/.exec(r.slice(i, i + 40));
        if (!m) { i += 2; continue; }
        const w = m[1], v = m[2] != null ? +m[2] : null;
        i += m[0].length;
        if (SKIP.has(w) && skipAt < 0) skipAt = depth;
        if (skipAt >= 0) continue;
        if (w === 'par' || w === 'line' || w === 'sect' || w === 'page') out += '\n';
        else if (w === 'tab') out += ' ';
        else if (w === 'uc' && v != null) uc = v;
        else if (w === 'u' && v != null) { out += String.fromCharCode(v < 0 ? v + 65536 : v); pending = uc; }
        else if (w === 'emdash') out += '—'; else if (w === 'endash') out += '–';
        else if (w === 'ldblquote') out += '“'; else if (w === 'rdblquote') out += '”';
        else if (w === 'lquote') out += '‘'; else if (w === 'rquote') out += '’';
        continue;
      }
      if (c === '\n' || c === '\r') { i++; continue; }
      if (skipAt < 0) { if (pending) pending--; else out += c; }
      i++;
    }
    return out;
  }

  /* ---------- PDF ---------- */
  let pdfjs = null;
  async function loadPdfJs() {
    if (pdfjs) return pdfjs;
    if (!window.pdfjsLib) {
      await new Promise((res, rej) => {
        const s = document.createElement('script'); s.src = PDFJS + 'pdf.min.js';
        s.onload = res; s.onerror = () => rej(new Error('No se pudo cargar el lector de PDF (¿hay conexión a internet?).'));
        document.head.appendChild(s);
      });
    }
    pdfjs = window.pdfjsLib;
    pdfjs.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.js';
    return pdfjs;
  }
  /* items de una página de pdf.js -> líneas [{text, y, h, w}] */
  function pdfLines(items) {
    const lines = []; let cur = null;
    for (const it of items) {
      if (!it.str && !it.hasEOL) continue;
      const x = it.transform[4], y = it.transform[5], h = Math.abs(it.height) || Math.abs(it.transform[3]) || 10;
      if (!cur || Math.abs(y - cur.y) > h * 0.5) {
        cur = { text: '', y, h, x0: x, x1: x, last: null }; lines.push(cur);
      }
      if (cur.last && it.str) {
        const gap = x - cur.last;
        if (gap > h * 0.15 && !/\s$/.test(cur.text) && !/^\s/.test(it.str)) cur.text += ' ';
      }
      cur.text += it.str;
      cur.last = x + (it.width || 0); cur.x1 = Math.max(cur.x1, cur.last);
    }
    return lines.map(l => ({ text: l.text.replace(/\s+/g, ' ').trim(), y: l.y, h: l.h, w: l.x1 - l.x0 })).filter(l => l.text);
  }
  /* líneas de una página -> párrafos (strings) */
  function pdfParas(lines) {
    if (!lines.length) return [];
    const maxW = Math.max(...lines.map(l => l.w));
    const paras = []; let cur = '';
    lines.forEach((l, i) => {
      const prev = lines[i - 1];
      let brk = false;
      if (prev) {
        const dy = Math.abs(prev.y - l.y);
        if (dy > Math.max(prev.h, l.h) * 1.7) brk = true;
        else if (/[.!?:»”"…]$/.test(prev.text) && prev.w < maxW * 0.7 && /^[A-ZÁÉÍÓÚÑ¿¡—"“«]/.test(l.text)) brk = true;
      }
      if (brk && cur) { paras.push(cur); cur = ''; }
      if (cur && /\p{L}-$/u.test(cur) && /^\p{Ll}/u.test(l.text)) cur = cur.slice(0, -1) + l.text;
      else cur = cur ? cur + ' ' + l.text : l.text;
    });
    if (cur) paras.push(cur);
    return paras;
  }
  /* quita números de página y cabeceras/pies repetidos */
  function pdfStrip(pagesLines) {
    const norm = t => t.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
    const count = new Map();
    pagesLines.forEach(ls => { for (const l of [ls[0], ls[ls.length - 1]]) if (l) count.set(norm(l.text), (count.get(norm(l.text)) || 0) + 1); });
    const lim = Math.max(3, Math.ceil(pagesLines.length * 0.4));
    return pagesLines.map(ls => ls.filter((l, i) => {
      const edge = i === 0 || i === ls.length - 1;
      if (!edge) return true;
      if (/^(p[áa]g(ina)?\.?|page)?\s*\d+(\s*(de|of|\/)\s*\d+)?$/i.test(l.text)) return false;
      return !(pagesLines.length >= 4 && count.get(norm(l.text)) >= lim);
    }));
  }
  async function pdfToDoc(file, name) {
    const lib = await loadPdfJs();
    const pdf = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    const pages = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      pages.push(pdfLines((await page.getTextContent()).items));
    }
    const clean = pdfStrip(pages);
    const total = clean.reduce((s, ls) => s + ls.reduce((a, l) => a + l.text.length, 0), 0);
    if (total < Math.max(200, pdf.numPages * 30)) throw new Error('Este PDF parece escaneado (son imágenes, sin texto) y no se puede leer.');
    // capítulos del índice del PDF, si lo tiene
    const heads = new Map();
    try {
      const out = await pdf.getOutline();
      if (out && out.length >= 2) for (const o of out) {
        let d = o.dest; if (typeof d === 'string') d = await pdf.getDestination(d);
        if (d && d[0] != null) { const idx = await pdf.getPageIndex(d[0]); (heads.get(idx) || heads.set(idx, []).get(idx)).push((o.title || '').trim()); }
      }
    } catch (e) { heads.clear(); }
    const blocks = [];
    clean.forEach((ls, pi) => {
      for (const t of heads.get(pi) || []) if (t) blocks.push({ text: t, kind: 'h', level: 1 });
      const paras = pdfParas(ls);
      paras.forEach((t, k) => {
        const last = blocks[blocks.length - 1];
        // párrafo cortado por el salto de página
        if (k === 0 && last && last.kind === 'p' && !(heads.get(pi) || []).length && !/[.!?:»”"…]$/.test(last.text) && /^\p{Ll}/u.test(t)) last.text += ' ' + t;
        else if (!heads.size && t.length <= 80 && HEADRE.test(t)) blocks.push({ text: t, kind: 'h', level: 1 });
        else blocks.push({ text: t, kind: 'p' });
      });
    });
    let title = name, author = '';
    try { const m = (await pdf.getMetadata()).info || {}; if (m.Title && m.Title.trim()) title = m.Title.trim(); if (m.Author) author = m.Author.trim(); } catch (e) {}
    return { title, author, blocks };
  }

  /* ---------- XML con su codificación declarada ---------- */
  function decodeXml(bytes) {
    const head = new TextDecoder('latin1').decode(bytes.subarray(0, 200));
    const m = /encoding\s*=\s*["']([\w.-]+)["']/i.exec(head);
    if (m && !/^utf-?8$/i.test(m[1])) { try { return new TextDecoder(m[1]).decode(bytes); } catch (e) { /* codificación desconocida */ } }
    return decodeText(bytes);
  }

  /* ---------- FB2 (FictionBook) ---------- */
  function fb2ToDoc(text, name) {
    const xml = parseXml(text);
    if (xml.getElementsByTagName('parsererror').length) throw new Error('El archivo FB2 está dañado.');
    const first = (root, n) => byLocal(root, n)[0];
    const info = first(xml, 'title-info');
    const title = info && first(info, 'book-title') ? first(info, 'book-title').textContent.trim() : '';
    const au = info && first(info, 'author');
    const author = au ? ['first-name', 'middle-name', 'last-name'].map(n => first(au, n) ? first(au, n).textContent.trim() : '').filter(Boolean).join(' ') : '';
    const lang = info && first(info, 'lang') ? first(info, 'lang').textContent.trim() : '';
    const inl = n => {
      let s = '';
      for (const c of n.childNodes) {
        if (c.nodeType === 3) { s += c.nodeValue; continue; }
        if (c.nodeType !== 1) continue;
        if (c.localName === 'image' || (c.localName === 'a' && c.getAttribute('type') === 'note')) continue;   // imágenes y llamadas a notas
        s += c.localName === 'emphasis' ? '' + inl(c) + '' : inl(c);
      }
      return s;
    };
    const clean = s => s.replace(/\s+/g, ' ').trim();
    const blocks = [];
    const walk = (node, depth) => {          // depth >= 90: dentro de una cita o un poema (no cuenta como capítulo)
      for (const c of node.children) {
        const l = c.localName;
        if (l === 'section') walk(c, depth + 1);
        else if (l === 'title') {
          const t = clean([...c.children].map(inl).join(' ')) || clean(inl(c));
          if (t) blocks.push(depth >= 90 ? { text: t, kind: 'p' } : { text: t, kind: 'h', level: Math.min(Math.max(depth, 1), 6) });
        } else if (l === 'p' || l === 'v' || l === 'subtitle' || l === 'text-author') { const t = clean(inl(c)); if (t) blocks.push({ text: t, kind: 'p' }); }
        else if (l === 'epigraph' || l === 'cite' || l === 'poem' || l === 'stanza' || l === 'annotation') walk(c, 99);
      }
    };
    for (const body of byLocal(xml, 'body')) { if (body.getAttribute('name') !== 'notes') walk(body, 0); }
    let cover = null;
    const cp = info && first(info, 'coverpage'), img = cp && first(cp, 'image');
    if (img) {
      const href = (img.getAttribute('l:href') || img.getAttribute('xlink:href') || img.getAttribute('href') || '').replace(/^#/, '');
      const bin = byLocal(xml, 'binary').find(b => b.getAttribute('id') === href);
      if (bin) { try { const raw = atob(bin.textContent.replace(/\s+/g, '')); cover = new Blob([Uint8Array.from(raw, ch => ch.charCodeAt(0))], { type: bin.getAttribute('content-type') || 'image/jpeg' }); } catch (e) { /* sin portada */ } }
    }
    return { title: title || name, author, blocks, cover, language: lang.slice(0, 2).toLowerCase() };
  }

  /* ---------- MOBI / AZW / AZW3 / PRC (Kindle, sin DRM) ---------- */
  function palmInflate(d) {
    const out = []; let i = 0;
    while (i < d.length) {
      const c = d[i++];
      if (c === 0 || (c >= 9 && c <= 0x7f)) out.push(c);
      else if (c <= 8) { for (let k = 0; k < c && i < d.length; k++) out.push(d[i++]); }
      else if (c >= 0xc0) out.push(0x20, c ^ 0x80);
      else { const c2 = (c << 8) | d[i++], dist = (c2 >> 3) & 0x7ff, len = (c2 & 7) + 3; for (let k = 0; k < len; k++) out.push(out[out.length - dist] || 0); }
    }
    return Uint8Array.from(out);
  }
  /* cada registro de texto puede llevar datos extra al final (se indica en las "flags") */
  function mobiTrim(rec, flags) {
    let end = rec.length;
    for (let bit = 1; bit <= 15; bit++) {
      if (!(flags & (1 << bit))) continue;
      let n = 0, shift = 0, p = end;
      for (;;) { const v = rec[--p]; n |= (v & 0x7f) << shift; shift += 7; if ((v & 0x80) || shift >= 28 || p <= 0) break; }
      end -= n;
    }
    if (flags & 1) end -= (rec[end - 1] & 3) + 1;
    return rec.subarray(0, Math.max(0, end));
  }
  async function mobiToDoc(file, name) {
    const buf = new Uint8Array(await file.arrayBuffer()), dv = new DataView(buf.buffer);
    const n = dv.getUint16(76), offs = [];
    for (let i = 0; i < n; i++) offs.push(dv.getUint32(78 + i * 8));
    const rec = i => buf.subarray(offs[i], i + 1 < n ? offs[i + 1] : buf.length);
    const r0 = rec(0), d0 = new DataView(r0.buffer, r0.byteOffset, r0.byteLength);
    const ascii = (a, o, l) => String.fromCharCode(...a.subarray(o, o + l));
    const comp = d0.getUint16(0), nText = d0.getUint16(8);
    if (d0.getUint16(12)) throw new Error('Este libro tiene protección (DRM) y no se puede leer.');
    const isMobi = ascii(r0, 16, 4) === 'MOBI';
    let enc = 1252, flags = 0, hl = 0, title = name, author = '', lang = '', cover = null;
    if (isMobi) { hl = d0.getUint32(20); enc = d0.getUint32(28); if (hl >= 0xe4 && r0.length >= 0xf4) flags = d0.getUint16(0xf2); }
    const dec = new TextDecoder(enc === 65001 ? 'utf-8' : 'windows-1252');
    if (isMobi) {
      const to = d0.getUint32(84), tl = d0.getUint32(88);
      if (to && tl && to + tl <= r0.length) title = dec.decode(r0.subarray(to, to + tl)).trim() || title;
      if ((d0.getUint32(128) & 0x40) && ascii(r0, 16 + hl, 4) === 'EXTH') {       // datos extra: autor, título, idioma, portada
        let p = 16 + hl; const cnt = d0.getUint32(p + 8); p += 12; let coverAt = -1; const authors = [];
        for (let i = 0; i < cnt && p + 8 <= r0.length; i++) {
          const t = d0.getUint32(p), len = d0.getUint32(p + 4), data = r0.subarray(p + 8, p + len);
          if (t === 100) authors.push(dec.decode(data).trim()); else if (t === 503) title = dec.decode(data).trim() || title;
          else if (t === 524) lang = dec.decode(data).slice(0, 2).toLowerCase(); else if (t === 201 && data.length === 4) coverAt = new DataView(data.buffer, data.byteOffset, 4).getUint32(0);
          if (len < 8) break; p += len;
        }
        author = authors.join(', ');
        const fi = d0.getUint32(0x6c);
        if (coverAt >= 0 && fi < n && fi + coverAt < n) { const im = rec(fi + coverAt); cover = new Blob([im], { type: im[0] === 0x89 ? 'image/png' : im[0] === 0x47 ? 'image/gif' : 'image/jpeg' }); }
      }
    }
    const parts = []; let total = 0;
    for (let i = 1; i <= nText && i < n; i++) {
      let r = mobiTrim(rec(i), flags);
      r = comp === 2 ? palmInflate(r) : comp === 1 ? r : null;
      if (!r) throw new Error('Este libro de Kindle usa una compresión que no se puede leer. Conviértelo a ePub (por ejemplo con Calibre) y vuelve a probar.');
      parts.push(r); total += r.length;
    }
    let all = new Uint8Array(total), o = 0;
    for (const p of parts) { all.set(p, o); o += p.length; }
    if (isMobi && d0.getUint32(36) === 8) {          // AZW3 (KF8): el texto del libro es el primer "flujo"; los demás son CSS, imágenes vectoriales, etc.
      const fi = d0.getUint32(0xc0);
      if (fi !== 0xffffffff && fi < n) {
        const f = rec(fi);
        if (f.length >= 20 && ascii(f, 0, 4) === 'FDST') { const end0 = new DataView(f.buffer, f.byteOffset, f.byteLength).getUint32(16); if (end0 > 0 && end0 <= all.length) all = all.subarray(0, end0); }
      }
    }
    const html = dec.decode(all);
    const secs = html.split(/<mbp:pagebreak\s*\/?>/i).map(s => Epub.blocksFromXhtml(s)).filter(b => b.length);
    let blocks = secs.flat();
    if (!blocks.some(b => b.kind === 'h') && secs.length >= 3) {      // sin títulos: cada salto de página es un capítulo
      blocks = secs.flatMap((s, k) => s[0].text.length <= 80 ? [{ ...s[0], kind: 'h', level: 1 }, ...s.slice(1)] : [{ text: 'Sección ' + (k + 1), kind: 'h', level: 1 }, ...s]);
    }
    return { title, author, blocks, cover, language: lang };
  }

  /* ---------- reconocer el formato por su contenido (la extensión puede faltar o estar mal) ---------- */
  async function detect(file, ext) {
    const head = new Uint8Array(await file.slice(0, 512).arrayBuffer());
    const a = String.fromCharCode(...head);
    if (a.startsWith('%PDF')) return 'pdf';
    if (a.startsWith('{\\rtf')) return 'rtf';
    if (head[0] === 0x50 && head[1] === 0x4b) {          // ZIP: epub, docx, odt, fb2.zip, htmlz…
      let names = []; try { names = (await Epub.readZip(file)).names(); } catch (e) { /* no es un ZIP legible */ }
      if (names.includes('META-INF/container.xml')) return 'epub';
      if (names.includes('word/document.xml')) return 'docx';
      if (names.includes('content.xml')) return 'odt';
      if (names.some(x => /\.fb2$/i.test(x))) return 'fb2zip';
      if (names.some(x => /\.x?html?$/i.test(x))) return 'htmlz';
      return ext;
    }
    if (a.slice(60, 68) === 'BOOKMOBI' || a.slice(60, 68) === 'TEXtREAd') return 'mobi';
    if (a.startsWith('\xd0\xcf\x11\xe0')) return 'ole';
    if (a.startsWith('AT&TFORM')) return 'djvu';
    if (/<FictionBook/i.test(a)) return 'fb2';
    return ext;
  }
  const UNSUPPORTED = 'Este formato no se puede leer directamente. Conviértelo a ePub, PDF, Word o texto (por ejemplo con Calibre) y vuelve a probar.';
  const looksBinary = b => {
    if ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff)) return false;   // UTF-16
    const n = Math.min(b.length, 4000); let bad = 0;
    for (let i = 0; i < n; i++) if (b[i] === 0 || (b[i] < 9) || (b[i] > 13 && b[i] < 32 && b[i] !== 27)) bad++;
    return n > 0 && bad / n > 0.05;
  };

  /* ---------- entrada principal ---------- */
  async function open(file) {
    const name = stripName(file.name || 'Texto');
    const ext = ((/\.([^.]+)$/.exec(file.name || '') || [])[1] || '').toLowerCase();
    let kind = await detect(file, ext);
    if (kind === 'kepub' || (kind === ext && file.type === 'application/epub+zip')) kind = 'epub';
    if (kind === 'epub') return Epub.open(file);
    const bytes = () => file.arrayBuffer().then(b => new Uint8Array(b));
    let doc;
    if (kind === 'pdf' || file.type === 'application/pdf') doc = await pdfToDoc(file, name);
    else if (kind === 'docx') doc = await docxToDoc(file, name);
    else if (kind === 'odt') doc = await odtToDoc(file, name);
    else if (kind === 'rtf') doc = { title: name, author: '', blocks: textToBlocks(rtfToText(decodeText(await bytes())), false) };
    else if (kind === 'mobi') doc = await mobiToDoc(file, name);
    else if (kind === 'fb2') doc = fb2ToDoc(decodeXml(await bytes()), name);
    else if (kind === 'fb2zip') { const z = await Epub.readZip(file); doc = fb2ToDoc(decodeXml(await z.get(z.names().find(x => /\.fb2$/i.test(x)))), name); }
    else if (kind === 'htmlz') {
      const z = await Epub.readZip(file), names = z.names().filter(x => /\.x?html?$/i.test(x));
      doc = htmlToDoc(decodeText(await z.get(names.find(x => /(^|\/)index\.x?html?$/i.test(x)) || names[0])), name);
    }
    else if (/^(html?|xhtml)$/.test(kind) || file.type === 'text/html') doc = htmlToDoc(decodeText(await bytes()), name);
    else if (/^(doc|ole|pages|odp|ods|xlsx|pptx|djvu?|cbz|cbr|lit|lrf|azw4|kfx|ibooks|zip|rar|7z)$/.test(kind)) throw new Error(UNSUPPORTED);
    else {
      const b = await bytes();
      if (looksBinary(b)) throw new Error(UNSUPPORTED);
      doc = { title: name, author: '', blocks: textToBlocks(decodeText(b), /^(md|markdown)$/.test(kind)) };
    }
    if (!doc.blocks.length) throw new Error('No se encontró texto en este archivo.');
    const chapters = chapterize(doc.blocks, doc.title);
    const sample = chapters.slice(0, 3).map(c => c.blocks.map(b => b.text).join(' ')).join(' ');
    return { title: doc.title, author: doc.author, language: doc.language || guessLang(sample), cover: doc.cover || null, chapters };
  }

  return { open };
})();
