'use strict';
/* Lector de ePub sin dependencias: ZIP (DecompressionStream) + OPF + texto por capítulos */
const Epub = (() => {
  const td = new TextDecoder('utf-8');

  async function inflateRaw(bytes) {
    const ds = new DecompressionStream('deflate-raw');
    const out = new Response(new Blob([bytes]).stream().pipeThrough(ds));
    return new Uint8Array(await out.arrayBuffer());
  }

  async function readZip(file) {
    const buf = new Uint8Array(await file.arrayBuffer());
    const dv = new DataView(buf.buffer);
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('No es un archivo ePub válido.');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const entries = new Map();
    for (let n = 0; n < count; n++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true);
      const csize = dv.getUint32(p + 20, true);
      const nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
      const lho = dv.getUint32(p + 42, true);
      const name = td.decode(buf.subarray(p + 46, p + 46 + nlen));
      entries.set(name, { method, csize, lho });
      p += 46 + nlen + elen + clen;
    }
    async function get(name) {
      const e = entries.get(name);
      if (!e) return null;
      const nlen = dv.getUint16(e.lho + 26, true), elen = dv.getUint16(e.lho + 28, true);
      const start = e.lho + 30 + nlen + elen;
      const raw = buf.subarray(start, start + e.csize);
      if (e.method === 0) return raw;
      if (e.method === 8) return inflateRaw(raw);
      throw new Error('Compresión de ePub no admitida.');
    }
    return { has: n => entries.has(n), names: () => [...entries.keys()], get };
  }

  const parseXml = (text, type = 'application/xml') => new DOMParser().parseFromString(text, type);
  const dirOf = p => p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '';
  function resolve(base, href) {
    href = decodeURIComponent(href.split('#')[0]);
    const parts = (base + href).split('/'), out = [];
    for (const s of parts) { if (s === '..') out.pop(); else if (s !== '.' && s !== '') out.push(s); }
    return out.join('/');
  }
  const byLocal = (root, name) => [...root.getElementsByTagName('*')].filter(e => e.localName === name);

  const BLOCKS = new Set(['p', 'div', 'li', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'tr', 'section', 'article', 'dd', 'dt', 'figcaption', 'pre']);
  const HEAD = /^h[1-6]$/;

  /* Devuelve [{text, kind}] con kind: 'p' (párrafo) o 'h' (título) */
  function blocksFromXhtml(xhtml) {
    let doc = parseXml(xhtml, 'application/xhtml+xml');
    if (doc.getElementsByTagName('parsererror').length) doc = parseXml(xhtml, 'text/html');
    const body = byLocal(doc, 'body')[0] || doc.documentElement;
    const out = [];
    let buf = '';
    const flush = kind => {
      const t = buf.replace(/\s+/g, ' ').trim();
      if (t) out.push({ text: t, kind });
      buf = '';
    };
    (function walk(node, kind) {
      for (const c of node.childNodes) {
        if (c.nodeType === 3) { buf += c.nodeValue; continue; }
        if (c.nodeType !== 1) continue;
        const n = c.localName.toLowerCase();
        if (n === 'script' || n === 'style' || n === 'svg' || n === 'head' || n === 'sup' && c.getAttribute('epub:type') === 'noteref') continue;
        if (n === 'br') { buf += ' '; continue; }
        if (BLOCKS.has(n)) {
          flush(kind);
          walk(c, HEAD.test(n) ? 'h' : kind);
          flush(HEAD.test(n) ? 'h' : kind);
        } else walk(c, kind);
      }
    })(body, 'p');
    flush('p');
    return out;
  }

  async function open(file) {
    const zip = await readZip(file);
    if (zip.has('META-INF/encryption.xml')) {
      const enc = td.decode(await zip.get('META-INF/encryption.xml'));
      if (/EncryptionMethod/i.test(enc) && !/obfuscation/i.test(enc)) {
        throw new Error('Este ePub tiene protección (DRM) y no se puede leer.');
      }
    }
    const cont = await zip.get('META-INF/container.xml');
    if (!cont) throw new Error('Falta META-INF/container.xml: no parece un ePub.');
    const rootEl = byLocal(parseXml(td.decode(cont)), 'rootfile')[0];
    const opfPath = rootEl && rootEl.getAttribute('full-path');
    if (!opfPath) throw new Error('No se encontró el contenido del libro.');
    const opf = parseXml(td.decode(await zip.get(opfPath)));
    const base = dirOf(opfPath);

    const meta = n => { const e = byLocal(opf, n)[0]; return e ? e.textContent.trim() : ''; };
    const manifest = new Map();
    for (const it of byLocal(opf, 'item')) {
      manifest.set(it.getAttribute('id'), {
        href: it.getAttribute('href'), type: it.getAttribute('media-type') || '', props: it.getAttribute('properties') || ''
      });
    }
    const spine = byLocal(opf, 'itemref').map(r => manifest.get(r.getAttribute('idref'))).filter(Boolean)
      .filter(m => /x?html/.test(m.type));

    let coverItem = [...manifest.values()].find(m => /cover-image/.test(m.props));
    if (!coverItem) {
      const cm = byLocal(opf, 'meta').find(m => m.getAttribute('name') === 'cover');
      if (cm) coverItem = manifest.get(cm.getAttribute('content'));
    }
    let cover = null;
    if (coverItem) {
      const data = await zip.get(resolve(base, coverItem.href));
      if (data) cover = new Blob([data], { type: coverItem.type || 'image/jpeg' });
    }

    const chapters = [];
    for (const it of spine) {
      const path = resolve(base, it.href);
      const data = await zip.get(path);
      if (!data) continue;
      const blocks = blocksFromXhtml(td.decode(data));
      const chars = blocks.reduce((s, b) => s + b.text.length, 0);
      const head = blocks.find(b => b.kind === 'h');
      chapters.push({ path, blocks, chars, title: head ? head.text.slice(0, 90) : '' });
    }
    chapters.forEach((c, i) => { if (!c.title) c.title = 'Sección ' + (i + 1); });
    return {
      title: meta('title') || file.name.replace(/\.epub$/i, ''),
      author: meta('creator'),
      language: meta('language'),
      cover, chapters
    };
  }

  /* Trocea un capítulo en frases con la pausa que debe llevar cada una (ritmo). */
  function toChunks(blocks, maxLen = 260) {
    const out = [];
    for (const b of blocks) {
      const text = b.text.replace(/…/g, '...').replace(/\s+/g, ' ').trim();
      const sentences = text.match(/[^.!?]+(?:[.!?]+["'»”)\]]*|$)\s*/g) || [text];
      let cur = '';
      const emit = (t, pause) => { t = t.trim(); if (/[\p{L}\p{N}]/u.test(t)) out.push({ text: t, pause }); else if (out.length) out[out.length - 1].pause = Math.max(out[out.length - 1].pause, pause); };
      for (const s of sentences) {
        if (cur && (cur + s).length > maxLen) { emit(cur, 0.28); cur = ''; }
        if (s.length > maxLen) {
          const parts = s.split(/(?<=[,;:])\s+/);
          for (const p of parts) {
            if (cur && (cur + p).length > maxLen) { emit(cur, 0.18); cur = ''; }
            cur += p + ' ';
          }
        } else cur += s;
        if (/[?!]["'»”)\]]*\s*$/.test(cur) || /\.\.\.\s*$/.test(cur)) { emit(cur, 0.42); cur = ''; }
        else if (/[.]["'»”)\]]*\s*$/.test(cur) && cur.length > 60) { emit(cur, 0.34); cur = ''; }
      }
      if (cur.trim()) emit(cur, 0.3);
      if (out.length) out[out.length - 1].pause = b.kind === 'h' ? 1.1 : 0.75;
    }
    return out;
  }

  return { open, toChunks, readZip };
})();
