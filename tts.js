'use strict';
/* Voz neuronal en el dispositivo (Piper vía @diffusionstudio/vits-web) + codificación a Opus/Ogg */
const Voice = (() => {
  const LIB_URLS = [
    'https://cdn.jsdelivr.net/npm/@diffusionstudio/vits-web@1.0.3/+esm',
    'https://esm.sh/@diffusionstudio/vits-web@1.0.3'
  ];
  const FALLBACK = ['es_ES-davefx-medium', 'es_ES-sharvard-medium', 'es_ES-carlfm-x_low'];
  /* Las 30 voces de Gemini: [nombre, sexo, tono] */
  const GEMINI_RAW = [
    ['Kore', 'f', 'firme'], ['Charon', 'm', 'informativo'], ['Sulafat', 'f', 'cálido'], ['Achird', 'm', 'amistoso'], ['Gacrux', 'f', 'maduro'],
    ['Zephyr', 'f', 'brillante'], ['Puck', 'm', 'alegre'], ['Aoede', 'f', 'desenfadado'], ['Orus', 'm', 'firme'], ['Fenrir', 'm', 'vivaz'],
    ['Leda', 'f', 'juvenil'], ['Callirrhoe', 'f', 'relajado'], ['Autonoe', 'f', 'brillante'], ['Enceladus', 'm', 'susurrante'], ['Iapetus', 'm', 'claro'],
    ['Umbriel', 'm', 'relajado'], ['Algieba', 'm', 'suave'], ['Despina', 'f', 'suave'], ['Erinome', 'f', 'claro'], ['Algenib', 'm', 'rasposo'],
    ['Rasalgethi', 'm', 'informativo'], ['Laomedeia', 'f', 'alegre'], ['Achernar', 'f', 'delicado'], ['Alnilam', 'm', 'firme'], ['Schedar', 'm', 'uniforme'],
    ['Pulcherrima', 'f', 'directo'], ['Zubenelgenubi', 'm', 'informal'], ['Vindemiatrix', 'f', 'amable'], ['Sadachbia', 'm', 'vivo'], ['Sadaltager', 'm', 'erudito']
  ];
  const GEMINI_VOICES = GEMINI_RAW.map(([n, g, d]) => ({ id: 'gemini:' + n, label: `${n} · ${g === 'f' ? 'mujer' : 'hombre'} · ${d}`, group: 'gemini' }));
  /* Los modelos de voz de Gemini cambian a menudo: se descubren con la clave y estos sirven de reserva, por orden de preferencia. */
  const GEMINI_PREF = ['gemini-3.8-flash-tts', 'gemini-3.1-flash-tts-preview', 'gemini-3.8-flash-lite-tts', 'gemini-2.5-flash-preview-tts', 'gemini-2.5-pro-preview-tts'];
  const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta/';
  const GEMINI_KEY_LS = 'lb-gemini-api-key', GEMINI_MODEL_LS = 'lb-gemini-model';
  const MAX_LS = 'lb-gemini-max', GAP_LS = 'lb-gemini-gap', COUNT_LS = 'lb-gemini-count', DEAD_LS = 'lb-gemini-dead';
  let lib = null, foundModels = null, goodModel = null;

  /* ---------- Ahorro de cuota ---------- */
  const lsRead = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const lsWrite = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };
  /* Caracteres por petición: menos peticiones = menos cuota. Gemini interpreta mejor tramos largos que frases sueltas. */
  function getGeminiMax() { const v = parseInt(lsRead(MAX_LS), 10); return v >= 800 && v <= 8000 ? v : 3000; }
  function setGeminiMax(v) { lsWrite(MAX_LS, String(v)); }
  /* Segundos mínimos entre el inicio de una petición y la siguiente (el límite por minuto del plan gratuito es muy bajo) */
  function getGeminiGap() { const v = parseFloat(lsRead(GAP_LS)); return v >= 0 && v <= 120 ? v : 15; }
  function setGeminiGap(v) { lsWrite(GAP_LS, String(v)); paceGap = null; }
  /* La cuota diaria de Google se reinicia a medianoche, hora del Pacífico */
  const pacificDay = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date());
  function requestsToday() {
    try { const c = JSON.parse(lsRead(COUNT_LS) || 'null'); return c && c.day === pacificDay() ? c.n : 0; } catch (e) { return 0; }
  }
  function countRequest() { lsWrite(COUNT_LS, JSON.stringify({ day: pacificDay(), n: requestsToday() + 1 })); }
  /* Modelos cuya cuota diaria ya se agotó hoy: se saltan y se prueba el siguiente (cada modelo tiene su propia cuota) */
  function deadModels() {
    try { const d = JSON.parse(lsRead(DEAD_LS) || 'null'); return d && d.day === pacificDay() ? d.models : []; } catch (e) { return []; }
  }
  function markDead(model) { lsWrite(DEAD_LS, JSON.stringify({ day: pacificDay(), models: [...new Set([...deadModels(), model])] })); }
  function resetDead() { lsWrite(DEAD_LS, JSON.stringify({ day: pacificDay(), models: [] })); }

  /* Pausa adaptativa: sube cuando Gemini protesta (429) y baja poco a poco cuando todo va bien */
  let paceNext = 0, paceGap = null;
  async function pace(o) {
    if (paceGap == null) paceGap = getGeminiGap();
    const at = Math.max(Date.now(), paceNext);
    paceNext = at + paceGap * 1000;
    while (Date.now() < at) {
      if (o.cancelled && o.cancelled()) throw cancelErr();
      if (o.onWait) o.onWait(`Pausa para no pasar el límite de Gemini… ${Math.ceil((at - Date.now()) / 1000)} s`);
      await new Promise(r => setTimeout(r, 500));
    }
  }
  const paceSlower = () => { paceGap = Math.min(75, (paceGap || getGeminiGap()) * 1.6 + 4); };
  const paceFaster = () => { paceGap = Math.max(getGeminiGap(), (paceGap || 0) * 0.92); };

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
    foundModels = null; goodModel = null; resetDead();   // otra clave = otro proyecto = otra cuota
  }
  function getGeminiModel() { try { return localStorage.getItem(GEMINI_MODEL_LS) || ''; } catch (e) { return ''; } }
  function setGeminiModel(m) {
    try { if (m) localStorage.setItem(GEMINI_MODEL_LS, m); else localStorage.removeItem(GEMINI_MODEL_LS); } catch (e) {}
    goodModel = null;
  }
  /* Modelos de voz que ofrece la clave del usuario (si no se puede consultar, la lista de reserva) */
  async function geminiModels() {
    if (foundModels) return foundModels;
    const key = getGeminiKey();
    if (!key) return GEMINI_PREF.slice();
    foundModels = GEMINI_PREF.slice();
    try {
      const r = await fetch(GEMINI_API + 'models?pageSize=200', { headers: { 'x-goog-api-key': key } });
      if (!r.ok) throw new Error(String(r.status));
      const j = await r.json();
      const names = (j.models || [])
        .filter(m => /tts/i.test(m.name) && (!m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent')))
        .map(m => m.name.replace(/^models\//, ''));
      const rank = n => { const i = GEMINI_PREF.indexOf(n); return i < 0 ? 99 : i; };
      if (names.length) foundModels = names.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    } catch (e) { /* nos quedamos con la lista de reserva */ }
    return foundModels;
  }
  async function modelChain() {
    const all = await geminiModels();
    const dead = deadModels();
    return [...new Set([getGeminiModel() || goodModel, ...all, ...GEMINI_PREF].filter(Boolean))].filter(m => !dead.includes(m));
  }
  async function ensureGeminiKey() {
    let key = getGeminiKey();
    if (key) return key;
    if (typeof window === 'undefined' || !window.prompt) throw new Error('Falta la clave de Gemini. Añádela desde el navegador para usar voces Gemini.');
    key = window.prompt('Pega tu clave de API de Google AI Studio para usar las voces Gemini. Se guarda solo en este navegador.', '');
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
  async function spanishVoices(quick) {   // quick: sin consultar el motor local (lista inmediata)
    let ids = [];
    if (!quick) try {
      const l = await load();
      const v = await l.voices();
      ids = Array.isArray(v) ? v.map(x => x.key || x.id || x.name) : Object.keys(v || {});
    } catch (e) { /* sin conexión: usamos la lista por defecto */ }
    ids = ids.filter(id => typeof id === 'string' && /^es_ES-/.test(id));   // solo voces de España
    if (!ids.length) ids = FALLBACK;
    const rank = id => /high/.test(id) ? 0 : /medium/.test(id) ? 1 : 2;
    ids.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    const local = ids.map(id => ({ id, label: pretty(id), group: 'local' }));
    return [...GEMINI_VOICES, ...local];
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

  /* ---------- Gemini ---------- */
  const cancelErr = () => { const e = new Error('Cancelado'); e.cancelled = true; return e; };
  const gemErr = msg => { const e = new Error(msg); e.fatal = true; return e; };   // error que detiene la conversión (se puede continuar luego)

  async function wait(sec, o, why) {
    const end = Date.now() + sec * 1000;
    while (Date.now() < end) {
      if (o.cancelled && o.cancelled()) throw cancelErr();
      if (o.onWait) o.onWait(`${why} Reintentando en ${Math.ceil((end - Date.now()) / 1000)} s…`);
      await new Promise(r => setTimeout(r, 500));
    }
  }
  async function errInfo(res) {
    let raw = ''; try { raw = await res.text(); } catch (e) {}
    let msg = `Error de Gemini (${res.status})`, retry = 0;
    try {
      const j = JSON.parse(raw); msg = (j.error && j.error.message) || msg;
      const d = ((j.error && j.error.details) || []).find(x => x && x.retryDelay);
      if (d) retry = parseFloat(d.retryDelay) || 0;
    } catch (e) {}
    if (!retry) { const m = /retry in ([\d.]+)s/i.exec(msg); if (m) retry = parseFloat(m[1]); }
    return { raw, msg, retry };
  }
  function friendly(status, msg) {
    if (/API key|API_KEY/i.test(msg)) return 'La clave de Gemini no es válida. Cámbiala con el botón de la clave en la pantalla de conversión.';
    if (status === 403) return 'Gemini no admite esta clave (403). Revisa la clave y sus permisos en Google AI Studio.';
    if (status === 401) return 'Gemini no reconoce la clave. Cámbiala con el botón de la clave en la pantalla de conversión.';
    return msg;
  }
  /* Gemini devuelve PCM de 16 bits sin cabecera (audio/L16;rate=24000); si algún modelo envía un WAV, también se entiende. */
  function audioFromGemini(inline) {
    const bin = atob(inline.data), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    if (bytes.length > 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return decodeWav(bytes);
    const m = /rate=(\d+)/i.exec(inline.mimeType || ''), rate = m ? +m[1] : 24000;
    const n = bytes.length >> 1, dv = new DataView(bytes.buffer), s = new Float32Array(n);
    for (let i = 0; i < n; i++) s[i] = dv.getInt16(i * 2, true) / 32768;
    return { samples: s, rate };
  }
  /* Las voces de Gemini no traen acento fijo: se pide en la instrucción (español de España, nunca latino) */
  const ACCENT = 'Si el texto está en español, pronúncialo con acento de España (castellano peninsular, con distinción de "z" y "c" suaves como en Madrid), nunca con acento latinoamericano, mexicano, argentino ni neutro de doblaje';
  /* La instrucción de estilo va delante del texto; es lo que da la entonación y la emoción */
  function geminiPrompt(text, o) {
    const how = !o.expr ? 'Lee en voz alta con naturalidad y un tono neutro'
      : o.role === 'dial' ? 'Lee en voz alta como el personaje de un diálogo, con la emoción y la entonación que pide cada frase'
        : 'Lee en voz alta como un narrador de audiolibros: entonación natural, emoción en los diálogos (preguntas, sorpresa, susurros, gritos, dudas) y pausas naturales';
    return `${how}. ${ACCENT}:\n\n${text}`;
  }

  async function synthGemini(text, id, o = {}) {
    const key = await ensureGeminiKey();
    const voice = id.replace(/^gemini:/, '');
    const body = JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: geminiPrompt(String(text || '').trim() || ' ', o) }] }],
      generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } }
    });
    let last = '', dailyHit = false;
    const chain = await modelChain();
    if (!chain.length) dailyHit = true;
    for (const model of chain) {
      let missing = false, exhausted = false;
      for (let attempt = 0; attempt < 6; attempt++) {
        if (o.cancelled && o.cancelled()) throw cancelErr();
        await pace(o);
        let res;
        try {
          countRequest();
          res = await fetch(`${GEMINI_API}models/${model}:generateContent`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body });
        } catch (e) { last = 'Sin conexión con Gemini.'; await wait(Math.min(30, 4 * (attempt + 1)), o, last); continue; }
        if (res.ok) {
          let j = null; try { j = await res.json(); } catch (e) {}
          const part = j && j.candidates && j.candidates[0] && j.candidates[0].content && (j.candidates[0].content.parts || []).find(p => p.inlineData && p.inlineData.data);
          if (part) { goodModel = model; paceFaster(); return audioFromGemini(part.inlineData); }
          last = 'Gemini no devolvió audio.';
          await wait(2 + attempt * 2, o, last); continue;
        }
        const info = await errInfo(res);
        if (res.status === 404 || (res.status === 400 && /not found|not supported|unsupported|no longer|deprecated/i.test(info.msg) && !/API key/i.test(info.msg))) { last = info.msg; missing = true; break; }   // ese modelo ya no existe: probamos otro
        if (res.status === 429) {
          if (/PerDay|per day|daily/i.test(info.raw)) { markDead(model); dailyHit = true; exhausted = true; last = info.msg; break; }   // cuota diaria de ESTE modelo: probamos otro
          last = 'Gemini pide esperar (límite por minuto).';
          paceSlower();
          const w = Math.min(90, Math.max(info.retry || 0, paceGap) + 2);
          paceNext = Date.now() + w * 1000;
          await wait(w, o, last); continue;
        }
        if (res.status >= 500) { last = info.msg; await wait(Math.min(30, 3 * (attempt + 1)), o, 'Gemini no responde.'); continue; }
        throw gemErr(friendly(res.status, info.msg));
      }
      if (!missing && !exhausted) break;   // se agotaron los reintentos con este modelo
    }
    if (dailyHit) throw gemErr('Se agotó la cuota diaria de Gemini (en todos los modelos disponibles). Se reinicia sobre las 8:00–9:00 de la mañana (hora de España). Lo ya convertido queda guardado: continúa entonces desde el libro, o activa la facturación en Google AI Studio.');
    throw gemErr(`Gemini no pudo generar el audio. ${last}`.trim());
  }

  /* Texto -> {samples: Float32Array, rate}. o: { expr, role, cancelled, onWait } (solo para Gemini) */
  async function synth(text, id, o = {}) {
    if (isGeminiVoice(id)) return synthGemini(text, id, o);
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

  return { spanishVoices, isStored, download, synth, createSink, load, isGeminiVoice, getGeminiKey, setGeminiKey, getGeminiModel, setGeminiModel, geminiModels,
    get GEMINI_MAX() { return getGeminiMax(); }, getGeminiMax, setGeminiMax, getGeminiGap, setGeminiGap, requestsToday, resetDead };
})();
