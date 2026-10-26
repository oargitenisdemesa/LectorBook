// Sustitución segura para quitar la entrada de texto manual y dejar solo importación de libros
// Pégalo dentro de index.html en el bloque de openEpub(), reemplazando la versión actual.

function openEpub() {
  let epub = null;
  sheet('Texto a audiolibro', `
    <label class="f">Archivo: ePub, PDF, Word (.docx), .txt, .md, .html, .odt o .rtf
      <input id="eFile" type="file" accept=".epub,.pdf,.docx,.odt,.rtf,.txt,.text,.md,.markdown,.html,.htm,.xhtml,.csv,.log,text/*,application/pdf,application/epub+zip"></label>
    <p class="hint" id="eMsg"></p>
    <div id="eRest" hidden>
      <label class="f">Título<input id="eTitle"></label>
      <label class="f">Autor<input id="eAuthor"></label>
      <div class="lbl">Capítulos a convertir</div><div class="chl" id="eList"></div>
      <p class="sum" id="eLang" style="color:var(--accent)" hidden></p>
      <div class="voice-box">
        <label class="f" style="margin:0;">Voz del narrador</label>
        <div class="voice-stack">
          <select class="sel" id="eVoice"></select>
          <button class="btn ghost gemini-badge" id="eGeminiKey" type="button">Clave Gemini</button>
        </div>
      </div>
      <div class="gemini-box" id="geminiBox" hidden>
        <div class="gemini-banner"><b>Voces Gemini</b><span>Más expresivas y naturales</span></div>
        <button class="btn wide gemini-cta" id="eGeminiTest">▶ Probar voz Gemini</button>
      </div>
      <label class="f">Voz de los diálogos<select class="sel" id="eVoiceD"></select></label>
      <label class="ck"><input type="checkbox" id="eExpr" checked><span>Lectura expresiva<small>Cambia el tono, el ritmo y el volumen según el contexto: preguntas, exclamaciones, susurros, grito, etc.</small></span></label>
      <p class="sum" id="eSum"></p>
      <button class="btn wide ghost" id="eTest">▶ Probar la voz</button>
      <button class="btn wide" id="eGo">Empezar la conversión</button>
    </div>`, () => {
    const isGeminiVoice = id => typeof id === 'string' && /^gemini:/.test(id);
    const syncGeminiUi = () => {
      const sel = $('#eVoice');
      const active = sel && isGeminiVoice(sel.value);
      const box = $('#geminiBox');
      if (box) box.hidden = !active;
      const keyBtn = $('#eGeminiKey');
      if (keyBtn) keyBtn.textContent = Voice.getGeminiKey() ? 'Clave Gemini: OK' : 'Clave Gemini';
    };

    const testVoice = async (voiceId, intention = 'Prueba') => {
      const btn = intention === 'Gemini' ? $('#eGeminiTest') : $('#eTest');
      const id = voiceId || $('#eVoice').value;
      const pair = $('#eVoiceD').value || id;
      btn.disabled = true;
      try {
        for (const v of [...new Set([id, pair])]) {
          if (!(await Voice.isStored(v))) await Voice.download(v, f => { btn.textContent = `Descargando la voz… ${Math.round(f * 100)}%`; });
        }
        btn.textContent = intention === 'Gemini' ? 'Generando…' : 'Generando…';
        const demo = [
          { kind: 'p', text: 'Ella lo miró en silencio. Afuera llovía desde hacía horas.' },
          { kind: 'p', text: '—¿De verdad? —preguntó ella.' },
          { kind: 'p', text: '—¡Claro que sí! —gritó él—. Y no se lo digas a nadie... —añadió en voz baja.' },
          { kind: 'p', text: '\uE000No puede ser verdad\uE001, pensó.' }
        ];
        const plan = $('#eExpr').checked ? Expr.plan(demo) : Epub.toChunks(demo).map(c => ({ ...c, role: 'narr', f: 1, g: 1 }));
        const ac = new (window.AudioContext || window.webkitAudioContext)(); let t = ac.currentTime + 0.2;
        for (const c of plan) {
          const r = await Voice.synth(c.text, c.role === 'dial' ? pair : id), sm = Expr.shape(r.samples, c.g);
          const buf = ac.createBuffer(1, sm.length, Math.round(r.rate * c.f)); buf.copyToChannel(sm, 0);
          const src = ac.createBufferSource(); src.buffer = buf; src.connect(ac.destination); src.start(t); t += buf.duration + c.pause;
        }
      } catch (e) { toast(String(e.message || e).slice(0, 140)); }
      btn.textContent = intention === 'Gemini' ? '▶ Probar voz Gemini' : '▶ Probar la voz';
      btn.disabled = false;
    };

    const fillVoices = async () => {
      const list = await Voice.spanishVoices(), sel = $('#eVoice');
      if (!sel) return;
      const saved = lsGet('lb-voice');
      const opts = list.map(v => `<option value="${v.id}">${esc(v.label)}</option>`).join('');
      sel.innerHTML = opts;
      if (saved && list.some(v => v.id === saved)) sel.value = saved;
      const sd = $('#eVoiceD'), savedD = lsGet('lb-voice-d');
      sd.innerHTML = '<option value="">La misma voz</option>' + opts;
      if (savedD && list.some(v => v.id === savedD)) sd.value = savedD;
      sel.onchange = syncGeminiUi;
      syncGeminiUi();
      const key = Voice.getGeminiKey();
      $('#eGeminiKey').textContent = key ? 'Clave Gemini: OK' : 'Clave Gemini';
    };

    const sum = () => {
      const boxes = [...document.querySelectorAll('#eList input:checked')];
      const chars = boxes.reduce((s, b) => s + epub.chapters[+b.value].chars, 0);
      const min = chars / 900;
      const mb = min * 60 * 4000 / 1e6 * 1.1;
      $('#eSum').textContent = boxes.length
        ? `${boxes.length} ${boxes.length === 1 ? 'capítulo' : 'capítulos'} · unos ${fmtLeft(min * 60)} de audio · ocupará unos ${Math.max(1, Math.round(mb))} MB. La conversión puede tardar varios minutos.`
        : 'Elige al menos un capítulo.';
      $('#eGo').disabled = !boxes.length;
    };

    const loadFile = async f => {
      $('#eMsg').textContent = 'Leyendo el texto…'; $('#eRest').hidden = true;
      try {
        epub = await Docs.open(f); epub.file = f;
        const usable = epub.chapters.filter(c => c.chars > 0).length;
        if (!usable) throw new Error('No se encontró texto en este archivo.');
        $('#eTitle').value = epub.title; $('#eAuthor').value = epub.author;
        $('#eList').innerHTML = epub.chapters.map((c, i) => c.chars > 0 ? `<label><input type="checkbox" value="${i}" ${c.chars >= 600 ? 'checked' : ''}><span>${esc(c.title)}</span><em>${fmtLeft([...])}</em></label>` : '').join('');
        if (!document.querySelector('#eList input:checked')) document.querySelectorAll('#eList input').forEach(i => { i.checked = true; });
        $('#eList').onchange = sum;
        const lg = $('#eLang'), l = (epub.language || '').slice(0, 2).toLowerCase();
        lg.hidden = !(l && l !== 'es');
        lg.textContent = `Este texto parece estar en ${l === 'en' ? 'inglés' : 'otro idioma'}. Las voces disponibles son de español y lo leerán con acento español.`;
        $('#eMsg').textContent = ''; $('#eRest').hidden = false; sum(); fillVoices();
      } catch (e) { $('#eMsg').textContent = String(e.message || e); }
    };

    $('#eFile').onchange = () => { const f = $('#eFile').files[0]; if (f) loadFile(f); };

    $('#eGeminiKey').onclick = () => {
      const current = Voice.getGeminiKey();
      const next = window.prompt('Introduce tu API key de Gemini (Google AI Studio).', current || '');
      if (next === null) return;
      const trimmed = next.trim();
      if (!trimmed) { Voice.setGeminiKey(''); $('#eGeminiKey').textContent = 'Clave Gemini'; toast('Clave Gemini eliminada'); return; }
      Voice.setGeminiKey(trimmed);
      $('#eGeminiKey').textContent = 'Clave Gemini: OK';
      toast('Clave Gemini guardada');
    };

    $('#eGeminiTest').onclick = async () => {
      const voiceId = $('#eVoice').value;
      if (!voiceId || !/^gemini:/.test(voiceId)) { toast('Selecciona primero una voz Gemini.'); return; }
      await testVoice(voiceId, 'Gemini');
    };

    $('#eTest').onclick = async () => { await testVoice($('#eVoice').value, 'General'); };

    $('#eGo').onclick = async () => {
      if (conv) { toast('Ya hay una conversión en marcha'); return; }
      const picks = [...document.querySelectorAll('#eList input:checked')].map(b => +b.value);
      if (!picks.length) return;
      const voice = $('#eVoice').value || 'es_ES-davefx-medium';
      lsSet('lb-voice', voice); lsSet('lb-voice-d', $('#eVoiceD').value || '');
      const id = uid();
      const book = {
        id,
        title: $('#eTitle').value.trim() || epub.title,
        author: $('#eAuthor').value.trim() || epub.author,
        cover: epub.cover,
        tracks: [],
        pos: { track: 0, time: 0 },
        speed: 1,
        bookmarks: [],
        added: Date.now(),
        lastPlayed: 0,
        finished: false,
        job: {
          voice,
          voiceDial: $('#eVoiceD').value || '',
          expr: $('#eExpr').checked,
          all: epub.chapters.filter((c, i) => picks.includes(i)).map((c, i) => ({ i: picks[i], title: c.title, chars: c.chars })),
          queue: picks.slice()
        }
      };
      books.push(book);
      await dbPut('books', book);
      closeSheet();
      renderAll();
      runJob(book);
    };
  });
}
