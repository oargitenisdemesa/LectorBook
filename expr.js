'use strict';
/* Lectura expresiva: reparte el texto en narración, diálogos, pensamientos (cursivas) y apartes,
   y da a cada frase su tono, ritmo, volumen y pausa según el contexto.
   El motor de voz no tiene control de emociones, así que el tono se consigue variando la velocidad
   y el timbre de cada frase (a mayor velocidad, voz más aguda y viva; a menor, más grave y pausada). */
const Expr = (() => {
  const I0 = '', I1 = '';

  /* El verbo que acompaña al diálogo («—dijo ella susurrando—») decide cómo se dice */
  const MOODS = [
    ['whisper', /susurr|murmur|musit|cuchiche|en voz baja|bajito|entre dientes/i],
    ['shout', /grit|chill|vocifer|bram|rugi|aull|a voz en cuello|a voces|espet/i],
    ['angry', /rabi|enfad|furios|bufó|bufo|gruñ|airad|colérico|iracund/i],
    ['surprise', /exclam|asombr|sorprend|atónit|atonit|estupefact|boquiabiert|maravill/i],
    ['sad', /suspir|lament|solloz|llor|gimi|con tristeza|apenad|afligid|entre lágrimas/i],
    ['joy', /(^|\s)(rió|rio|reía|reia|rieron)(?=[\s,.;:!?]|$)|sonri|carcaj|alegre|entusiasmad|feliz|jubilos/i],
    ['hesitant', /balbuce|titube|tartamude|dudó|dudo |vacil/i]
  ];
  const MOOD_STYLE = {
    whisper: { f: 0.93, g: 0.6 }, shout: { f: 1.07, g: 1.4 }, angry: { f: 1.04, g: 1.25 },
    surprise: { f: 1.06, g: 1.15 }, sad: { f: 0.94, g: 0.8 }, joy: { f: 1.05, g: 1.1 },
    hesitant: { f: 0.97, g: 0.9, pause: 0.2 }
  };
  const moodOf = t => { for (const [m, re] of MOODS) if (re.test(t)) return m; return ''; };

  /* Divide un párrafo en tramos: { t, dial, ital, aside } */
  function runsOf(text) {
    const dash = /^[\s]*—/.test(text);
    const runs = []; let buf = '', dlg = false, ital = false, aside = false;
    const push = () => { const t = buf.replace(/^[\s,;:.]+/, ''); if (t.trim()) runs.push({ t, dial: dlg, ital, aside }); buf = ''; };
    for (const c of text) {
      if (c === I0) { push(); ital = true; continue; }
      if (c === I1) { push(); ital = false; continue; }
      if (c === '(') { push(); aside = true; continue; }
      if (c === ')') { push(); aside = false; continue; }
      if (dash) { if (c === '—') { push(); dlg = !dlg; continue; } if (/["«»“”]/.test(c)) continue; }
      else if (c === '«' || c === '“') { push(); dlg = true; continue; }
      else if (c === '»' || c === '”') { push(); dlg = false; continue; }
      else if (c === '"') { push(); dlg = !dlg; continue; }
      buf += c;
    }
    push();
    return runs.filter(r => /[\p{L}\p{N}]/u.test(r.t));
  }

  function sentencesOf(t, maxLen = 260) {
    t = t.replace(/…/g, '...').replace(/\s+/g, ' ').trim();
    const sents = t.match(/[^.!?]+(?:[.!?]+["'»”)\]]*|$)\s*/g) || [t];
    const out = []; let cur = '';
    for (const s of sents) {
      if (cur && (cur + s).length > maxLen) { out.push(cur.trim()); cur = ''; }
      if (s.length > maxLen) {
        for (const p of Epub.splitLong(s, maxLen)) { if (cur && (cur + p).length > maxLen) { out.push(cur.trim()); cur = ''; } cur += p + ' '; }
      } else cur += s;
      if (/[.!?]["'»”)\]]*\s*$/.test(cur) && cur.length > 40 || /[?!]["'»”)\]]*\s*$/.test(cur)) { out.push(cur.trim()); cur = ''; }
    }
    if (cur.trim()) out.push(cur.trim());
    return out.filter(x => /[\p{L}\p{N}]/u.test(x));
  }

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function styleOf(text, o) {
    let f = 1, g = 1, pause = 0;
    const apply = (s, k = 1) => { f *= 1 + (s.f - 1) * k; g *= 1 + (s.g - 1) * k; pause += (s.pause || 0) * k; };
    const k = o.dial ? 1 : 0.5;                      // la narración se contiene más que los diálogos
    if (o.mood && MOOD_STYLE[o.mood]) apply(MOOD_STYLE[o.mood]);
    const letters = text.match(/\p{L}/gu) || [], upper = text.match(/\p{Lu}/gu) || [];
    const caps = letters.length >= 4 && upper.length / letters.length > 0.6;
    if (caps && o.mood !== 'whisper') apply(MOOD_STYLE.shout);
    else if (/!["'»”)\]]*\s*$/.test(text) && !/^[^!]*\.\.\.\s*$/.test(text)) { apply({ f: 1.05, g: 1.2 }, k); if (/!!|\?!|!\?/.test(text)) apply({ f: 1.02, g: 1.1 }, k); }
    else if (/\?["'»”)\]]*\s*$/.test(text)) apply({ f: 1.02, g: 1.05 }, k);
    if (/\.\.\.["'»”)\]]*\s*$/.test(text)) { apply({ f: 0.95, g: 0.9 }, Math.max(k, 0.7)); pause += 0.25; }
    if (o.ital) apply({ f: 0.95, g: 0.88 });         // pensamiento o voz en off
    if (o.head) apply({ f: 0.96, g: 1.08 });
    if (o.aside) apply({ f: 0.96, g: 0.88 });
    return { f: clamp(f, 0.88, 1.1), g: clamp(g, 0.5, 1.5), pause };
  }

  /* blocks -> [{ text, pause, role:'narr'|'dial', f, g }] */
  function plan(blocks) {
    const out = [];
    for (const b of blocks) {
      if (b.kind === 'h') {
        const t = b.text.replace(/[]/g, '').trim();
        if (/[\p{L}\p{N}]/u.test(t)) { const st = styleOf(t, { head: true }); out.push({ text: t, pause: 1.1, role: 'narr', f: st.f, g: st.g }); }
        continue;
      }
      const rs = runsOf(b.text);
      const isDash = /^[\s]*—/.test(b.text);
      const blockOut = [];
      rs.forEach((r, i) => {
        let mood = '';
        if (r.dial) {
          const nxt = rs[i + 1] && !rs[i + 1].dial ? rs[i + 1] : (rs[i - 1] && !rs[i - 1].dial ? rs[i - 1] : null);
          if (nxt) mood = moodOf(nxt.t);
        }
        const tagFollows = r.dial && rs[i + 1] && !rs[i + 1].dial;
        const sents = sentencesOf(r.t);
        const wholeItal = r.ital && !r.dial;
        const aside = r.aside;
        sents.forEach((s, k) => {
          let text = s;
          if (k === sents.length - 1 && tagFollows && !/[.!?…,;:]["'»”)\]]*$/.test(text)) text += ',';   // la frase sigue tras el inciso
          const st = styleOf(text, { dial: r.dial, mood, ital: wholeItal || (r.ital && !r.dial), aside });
          let pause = /\.\.\.["'»”)\]]*$/.test(text) ? 0.5 : /[?!]["'»”)\]]*$/.test(text) ? 0.42 : /[,;:]$/.test(text) ? 0.15 : 0.34;
          pause += st.pause;
          if (k === sents.length - 1 && rs[i + 1] && rs[i + 1].dial !== r.dial) pause = Math.min(pause, 0.12);   // diálogo ↔ inciso sin corte
          blockOut.push({ text, pause, role: r.dial ? 'dial' : 'narr', f: st.f, g: st.g });
        });
      });
      if (blockOut.length) blockOut[blockOut.length - 1].pause = isDash ? 0.55 : 0.75;
      out.push(...blockOut);
    }
    return out;
  }

  /* volumen con compresión suave para que no sature */
  function shape(samples, g) {
    if (Math.abs(g - 1) < 0.02) return samples;
    const o = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) { const v = samples[i] * g; o[i] = g > 1 ? Math.tanh(v) : v; }
    return o;
  }

  return { plan, shape };
})();
