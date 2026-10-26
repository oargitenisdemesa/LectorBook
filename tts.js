'use strict';
/* Voz neuronal en el dispositivo (Piper vía @diffusionstudio/vits-web) + codificación a Opus/Ogg */
const Voice = (() => {
  const LIB_URLS = [
    'https://cdn.jsdelivr.net/npm/@diffusionstudio/vits-web@1.0.3/+esm',
    'https://esm.sh/@diffusionstudio/vits-web@1.0.3'
  ];
  const FALLBACK = ['es_ES-davefx-medium', 'es_ES-sharvard-medium', 'es_ES-carlfm-x_low'];
  const GEMINI_VOICES = [
    { id: 'gemini:Kore', label: 'Gemini · Kore · expresiva' },
    { id: 'gemini:Charon', label: 'Gemini · Charon · grave y narrativa' },
    { id: 'gemini:Aoede', label: 'Gemini · Aoede · clara y cálida' },
    { id: 'gemini:Puck', label: 'Gemini · Puck · dinámica' },
    { id: 'gemini:Orus', label: 'Gemini · Orus · serena' },
    { id: 'gemini:Zephyr', label: 'Gemini · Zephyr · ligera' }
  ];
  const GEMINI_MODEL = 'gemini-2.5-flash-preview-tts';
  const GEMINI_KEY_LS = 'lb-gemini-api-key';
  let lib = null;

  function isGeminiVoice(id) {
    return typeof id === 'string' && /^gemini:/.test(id);
  }
  function getGeminiKey() {
    try {
      const saved = localStorage.getItem(GEMINI_KEY_LS);
      return saved ? saved.trim() : '';
    } catch (e) { return ''; }
  }
  function setGeminiKey(key) {
    try { if (key) localStorage.setItem(GEMINI_KEY_LS, key.trim()); else localStorage.removeItem(GEMINI_KEY_LS); } catch (e) {}
  }
  async function ensureGeminiKey() {
    let key = getGeminiKey();
    if (key) return key;
    if (typeof window === 'undefined' || !window.prompt) throw new Error('Falta la clave de Gemini. Añádela desde el navegador para usar voces Gemini.');
    key = window.prompt('Ingresa tu API key de Google AI Studio para usar voces Gemini. Se guarda en este navegador.', '');
    if (!key || !key.trim()) throw new Error('Se necesita una API key de Gemini para usar estas voces.');
    key = key.trim(); setGeminiKey(key); return key;
  }

  async function load() {
    if (lib) return lib;
    let err;
    for (const u of LIB_URLS) {
      try { lib = await import(u); return lib; } catch (e) { err = e; }
    }
    throw new Error('No se pudo cargar el motor de voz (¿hay conexión a internet?). ' + (err && err.message || ''));
  }

  const LABEL = { ES: 'España', MX: 'México', AR: 'Argentina', CO: 'Colombia' };
  const QUAL = { x_low: 'básica', low: 'básica', medium: 'media', high: 'alta' };
  function pretty(id) {
    const m = /^es_([A-Z]{2})-(.+)-(x_low|low|medium|high)$/.exec(id);
    return m ? `${LABEL[m[1]] || m[1]} · ${m[2].replace(/_/g, ' ')} · calidad ${QUAL[m[3]]}` : id;
  }
  async function spanishVoices() {
    let ids = [];
    try {
      const l = await load();
      const v = await l.voices();
      ids = Array.isArray(v) ? v.map(x => x.key || x.id || x.name) : Object.keys(v || {});
    } catch (e) { /* sin conexión: usamos la lista por defecto */ }
    ids = ids.filter(id => typeof id === 'string' && /^es_ES-/.test(id));   // solo voces de España
    if (!ids.length) ids = FALLBACK;
    const rank = id => /high/.test(id) ? 0 : /medium/.test(id) ? 1 : 2;
    ids.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    const local = ids.map(id => ({ id, label: pretty(id) }));
    return [...local, ...GEMINI_VOICES.map(v => ({ ...v, label: v.label }))];
  }
  async function isStored(id) {
    if (isGeminiVoice(id)) return true;
    try { return (await (await load()).stored()).includes(id); } catch (e) { return false; }
  }
  async function download(id, onProgress) {
    if (isGeminiVoice(id)) { if (onProgress) onProgress(1); return; }
    const l = await load();
    await l.download(id, p => { if (onProgress && p && p.total) onProgress(p.loaded / p.total); });
  }

  async function synthGemini(text, id) {
    const key = await ensureGeminiKey();
    const voice = id.replace(/^gemini:/, '');
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: String(text || '').trim() || ' ' }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: voice }
            }
          }
        }
      })
    });
    if (!response.ok) {
      let detail = `Error de Gemini (${response.status})`;
      try { const data = await response.json(); detail = data?.error?.message || detail; } catch (e) {}
      throw new Error(detail);
    }
    const body = await response.json();
    const part = body?.candidates?.[0]?.content?.parts?.find(p => p.inlineData && p.inlineData.data);
    if (!part) throw new Error('Gemini no devolvió audio. Comprueba que la voz sea compatible y la clave sea válida.');
    const data = part.inlineData.data;
    const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
    return decodeWav(bytes);
  }

  /* Texto -> {samples: Float32Array, rate} */
  async function synth(text, id) {
    if (isGeminiVoice(id)) return synthGemini(text, id);
    const l = await load();
    const out = await l.predict({ text, voiceId: id });
    const blob = out instanceof Blob ? out : new Blob([out], { type: 'audio/wav' });
    return decodeWav(new Uint8Array(await blob.arrayBuffer()));
  }

  function decodeWav(b) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    if (String.fromCharCode(...b.subarray(0, 4)) !== 'RIFF') throw new Error('La voz devolvió un audio no válido.');
    let p = 12, fmt = null, data = null;
    while (p + 8 <= b.length) {
      const id = String.fromCharCode(...b.subarray(p, p + 4)), size = dv.getUint32(p + 4, true);
      if (id === 'fmt ') fmt = { tag: dv.getUint16(p + 8, true), ch: dv.getUint16(p + 10, true), rate: dv.getUint32(p + 12, true), bits: dv.getUint16(p + 22, true) };
      if (id === 'data') { data = [p + 8, Math.min(size, b.length - p - 8)]; break; }
      p += 8 + size + (size & 1);
    }
    if (!fmt || !data) throw new Error('La voz devolvió un audio no válido.');
    const bytes = fmt.bits / 8, n = Math.floor(data[1] / (bytes * fmt.ch));
    const s = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const o = data[0] + i * bytes * fmt.ch;   // primer canal
      s[i] = fmt.tag === 3 ? dv.getFloat32(o, true) : fmt.bits === 16 ? dv.getInt16(o, true) / 32768 : (dv.getUint8(o) - 128) / 128;
    }
    return { samples: s, rate: fmt.rate };
  }

  /* ---------- Ogg ---------- */
  const CRC = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) { let r = i << 24; for (let j = 0; j < 8; j++) r = (r & 0x80000000) ? ((r << 1) ^ 0x04c11db7) : (r << 1); t[i] = r >>> 0; }
    return t;
  })();
  function oggPage(packets, granule, serial, seq, flags) {
    const lacing = [];
    for (const p of packets) { let l = p.length; while (l >= 255) { lacing.push(255); l -= 255; } lacing.push(l); }
    const body = packets.reduce((s, p) => s + p.length, 0);
    const out = new Uint8Array(27 + lacing.length + body), dv = new DataView(out.buffer);
    out.set([0x4f, 0x67, 0x67, 0x53, 0, flags]);
    dv.setBigUint64(6, BigInt(granule), true);
    dv.setUint32(14, serial, true); dv.setUint32(18, seq, true);
    out[26] = lacing.length; out.set(lacing, 27);
    let o = 27 + lacing.length;
    for (const p of packets) { out.set(p, o); o += p.length; }
    let crc = 0;
    for (let i = 0; i < out.length; i++) crc = ((crc << 8) ^ CRC[((crc >>> 24) ^ out[i]) & 0xff]) >>> 0;
    dv.setUint32(22, crc, true);
    return out;
  }
  function opusHead(pre) {
    const h = new Uint8Array(19), dv = new DataView(h.buffer);
    h.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, 1, 1]);
    dv.setUint16(10, pre, true); dv.setUint32(12, 48000, true);
    return h;
  }
  function opusTags() {
    const v = new TextEncoder().encode('LectorBook');
    const t = new Uint8Array(8 + 4 + v.length + 4), dv = new DataView(t.buffer);
    t.set([0x4f, 0x70, 0x75, 0x73, 0x54, 0x61, 0x67, 0x73]);
    dv.setUint32(8, v.length, true); t.set(v, 12);
    return t;
  }

  /* Sumidero que codifica a Opus (≈ 10 veces menos espacio que WAV); si el navegador no puede, WAV. */
  async function createSink(bitrate = 32000) {
    const hasOpus = typeof AudioEncoder !== 'undefined' && (await AudioEncoder.isConfigSupported({ codec: 'opus', sampleRate: 48000, numberOfChannels: 1, bitrate })).supported;
    return hasOpus ? new OpusSink(bitrate) : new WavSink();
  }

  function resample(src, from, to) {
    if (from === to) return src;
    const n = Math.floor(src.length * to / from), out = new Float32Array(n), k = from / to;
    for (let i = 0; i < n; i++) {
      const x = i * k, i0 = Math.floor(x), f = x - i0;
      out[i] = src[i0] * (1 - f) + (src[Math.min(i0 + 1, src.length - 1)] * f);
    }
    return out;
  }

  class OpusSink {
    constructor(bitrate) {
      this.kind = 'opus'; this.bitrate = bitrate;
      this.packets = []; this.pending = new Float32Array(0); this.samples = 0; this.head = null; this.err = null;
      this.enc = new AudioEncoder({
        output: (chunk, meta) => {
          const d = new Uint8Array(chunk.byteLength); chunk.copyTo(d); this.packets.push(d);
          if (!this.head && meta && meta.decoderConfig && meta.decoderConfig.description) {
            const desc = new Uint8Array(meta.decoderConfig.description.buffer || meta.decoderConfig.description);
            if (desc.length >= 19 && desc[0] === 0x4f) this.head = desc;
          }
        },
        error: e => { this.err = e; }
      });
      this.enc.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 1, bitrate });
    }
    get seconds() { return this.samples / 48000; }
    async add(samples, rate) {
      const s = resample(samples, rate, 48000);
      const merged = new Float32Array(this.pending.length + s.length);
      merged.set(this.pending); merged.set(s, this.pending.length);
      let o = 0;
      while (merged.length - o >= 960) {
        this.frame(merged.subarray(o, o + 960)); o += 960;
        if (this.enc.encodeQueueSize > 40) await new Promise(r => setTimeout(r, 5));
      }
      this.pending = merged.slice(o);
      if (this.err) throw this.err;
    }
    silence(sec) { return this.add(new Float32Array(Math.round(sec * 48000)), 48000); }
    frame(f) {
      const data = new Float32Array(f);
      this.enc.encode(new AudioData({ format: 'f32', sampleRate: 48000, numberOfFrames: 960, numberOfChannels: 1, timestamp: Math.round(this.samples / 48000 * 1e6), data }));
      this.samples += 960;
    }
    async finish() {
      if (this.pending.length) { const f = new Float32Array(960); f.set(this.pending); this.frame(f); this.pending = new Float32Array(0); }
      await this.enc.flush(); this.enc.close();
      if (this.err) throw this.err;
      const pre = this.head ? new DataView(this.head.buffer, this.head.byteOffset).getUint16(10, true) : 312;
      const serial = (Math.random() * 2 ** 32) >>> 0, pages = [];
      let seq = 0;
      pages.push(oggPage([this.head || opusHead(pre)], 0, serial, seq++, 0x02));
      pages.push(oggPage([opusTags()], 0, serial, seq++, 0));
      let i = 0, done = 0;
      while (i < this.packets.length) {
        const grp = []; let lac = 0;
        while (i < this.packets.length && grp.length < 50 && lac + Math.floor(this.packets[i].length / 255) + 1 <= 250) {
          lac += Math.floor(this.packets[i].length / 255) + 1; grp.push(this.packets[i++]);
        }
        done += grp.length * 960;
        pages.push(oggPage(grp, pre + done, serial, seq++, i >= this.packets.length ? 0x04 : 0));
      }
      return { blob: new Blob(pages, { type: 'audio/ogg' }), ext: 'ogg', seconds: this.samples / 48000 };
    }
  }

  class WavSink {
    constructor() { this.kind = 'wav'; this.parts = []; this.n = 0; this.rate = 22050; }
    get seconds() { return this.n / this.rate; }
    async add(samples, rate) {
      samples = resample(samples, rate, this.rate);
      const i16 = new Int16Array(samples.length);
      for (let i = 0; i < samples.length; i++) i16[i] = Math.max(-1, Math.min(1, samples[i])) * 32767;
      this.parts.push(i16); this.n += i16.length;
    }
    silence(sec) { return this.add(new Float32Array(Math.round(sec * this.rate)), this.rate); }
    async finish() {
      const h = new DataView(new ArrayBuffer(44)), len = this.n * 2;
      const w = (o, s) => [...s].forEach((c, i) => h.setUint8(o + i, c.charCodeAt(0)));
      w(0, 'RIFF'); h.setUint32(4, 36 + len, true); w(8, 'WAVEfmt '); h.setUint32(16, 16, true);
      h.setUint16(20, 1, true); h.setUint16(22, 1, true); h.setUint32(24, this.rate, true);
      h.setUint32(28, this.rate * 2, true); h.setUint16(32, 2, true); h.setUint16(34, 16, true);
      w(36, 'data'); h.setUint32(40, len, true);
      return { blob: new Blob([h.buffer, ...this.parts], { type: 'audio/wav' }), ext: 'wav', seconds: this.seconds };
    }
  }

  return { spanishVoices, isStored, download, synth, createSink, load, isGeminiVoice, getGeminiKey, setGeminiKey };
})();
