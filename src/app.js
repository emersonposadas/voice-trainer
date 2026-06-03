const noteToSemitone = {
  C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5,
  'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11
};
const semitoneToNote = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const naturalNotes = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const voiceRules = {
  C: { high: 'E', low: 'G#' },
  D: { high: 'F#', low: 'A#' },
  E: { high: 'G#', low: 'C' },
  F: { high: 'A', low: 'C#' },
  G: { high: 'B', low: 'D#' },
  A: { high: 'C#', low: 'F' },
  B: { high: 'D#', low: 'G' }
};

const $ = (id) => document.getElementById(id);
const state = {
  audioContext: null,
  analyser: null,
  stream: null,
  recording: false,
  practicing: false,
  recordedFrames: [],
  melody: [
    { note: 'D4', duration: 0.5, result: '-' },
    { note: 'E4', duration: 0.5, result: '-' },
    { note: 'F4', duration: 0.5, result: '-' },
    { note: 'G4', duration: 1.0, result: '-' }
  ],
  practiceStart: 0,
  raf: null
};

function parseNote(note) {
  const match = String(note).trim().toUpperCase().match(/^([A-G]#?)(-?\d+)$/);
  if (!match) throw new Error(`Nota inválida: ${note}`);
  return { name: match[1], octave: Number(match[2]) };
}

function noteToMidi(note) {
  const { name, octave } = parseNote(note);
  return 12 * (octave + 1) + noteToSemitone[name];
}

function midiToNote(midi) {
  const pitch = ((midi % 12) + 12) % 12;
  const octave = Math.floor(midi / 12) - 1;
  return `${semitoneToNote[pitch]}${octave}`;
}

function midiToFrequency(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function frequencyToMidi(freq) {
  return Math.round(69 + 12 * Math.log2(freq / 440));
}

function centsOff(freq, targetFreq) {
  return 1200 * Math.log2(freq / targetFreq);
}

function frequencyToNote(freq, quantizeMode = $('quantizeMode').value) {
  if (!freq || freq < 50 || freq > 1200) return null;
  let midi = frequencyToMidi(freq);
  if (quantizeMode === 'natural') midi = nearestNaturalMidi(midi);
  return midiToNote(midi);
}

function nearestNaturalMidi(midi) {
  let best = midi;
  let bestDist = Infinity;
  for (let candidate = midi - 2; candidate <= midi + 2; candidate++) {
    const name = semitoneToNote[((candidate % 12) + 12) % 12];
    if (naturalNotes.includes(name)) {
      const dist = Math.abs(candidate - midi);
      if (dist < bestDist) {
        best = candidate;
        bestDist = dist;
      }
    }
  }
  return best;
}

function getRelativeVoice(note, mode) {
  const { name } = parseNote(note);
  if (!voiceRules[name]) return null;
  const sourceMidi = noteToMidi(note);
  const targetName = voiceRules[name][mode];
  const targetSemitone = noteToSemitone[targetName];
  let targetMidi = sourceMidi;

  if (mode === 'high') {
    while (((targetMidi % 12) + 12) % 12 !== targetSemitone || targetMidi <= sourceMidi) targetMidi++;
  } else {
    while (((targetMidi % 12) + 12) % 12 !== targetSemitone || targetMidi >= sourceMidi) targetMidi--;
  }
  return midiToNote(targetMidi);
}

async function ensureAudio() {
  if (state.audioContext && state.analyser) return;
  state.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false } });
  state.audioContext = new AudioContext();
  const source = state.audioContext.createMediaStreamSource(state.stream);
  state.analyser = state.audioContext.createAnalyser();
  state.analyser.fftSize = 2048;
  source.connect(state.analyser);
  $('micStatus').textContent = 'Micrófono activo';
}

function detectPitch(analyser, audioContext) {
  const buffer = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(buffer);

  let rms = 0;
  for (const sample of buffer) rms += sample * sample;
  rms = Math.sqrt(rms / buffer.length);
  $('volumeBar').style.width = `${Math.min(100, rms * 700)}%`;
  if (rms < 0.015) return { freq: null, rms };

  const sampleRate = audioContext.sampleRate;
  let bestOffset = -1;
  let bestCorrelation = 0;
  const minOffset = Math.floor(sampleRate / 1000);
  const maxOffset = Math.floor(sampleRate / 70);

  for (let offset = minOffset; offset <= maxOffset; offset++) {
    let correlation = 0;
    for (let i = 0; i < buffer.length - offset; i++) {
      correlation += buffer[i] * buffer[i + offset];
    }
    correlation /= buffer.length - offset;
    if (correlation > bestCorrelation) {
      bestCorrelation = correlation;
      bestOffset = offset;
    }
  }

  if (bestCorrelation < 0.003 || bestOffset <= 0) return { freq: null, rms };
  return { freq: sampleRate / bestOffset, rms };
}

function updateLivePitch() {
  if (!state.analyser || !state.audioContext) return;
  const { freq } = detectPitch(state.analyser, state.audioContext);
  const note = frequencyToNote(freq, 'chromatic');
  $('liveFreq').textContent = freq ? `${freq.toFixed(1)} Hz` : '-- Hz';
  $('liveNote').textContent = note || '--';

  if (state.recording) {
    const detected = frequencyToNote(freq);
    state.recordedFrames.push({ time: performance.now(), note: detected, freq });
  }

  if (state.practicing) updatePractice(freq);
  state.raf = requestAnimationFrame(updateLivePitch);
}

function processRecording() {
  const frames = state.recordedFrames.filter(f => f.note);
  if (!frames.length) return;
  const segments = [];
  let current = { note: frames[0].note, start: frames[0].time, end: frames[0].time };
  for (const frame of frames.slice(1)) {
    if (frame.note === current.note || frame.time - current.end < 120) {
      current.end = frame.time;
      if (frame.note !== current.note) current.note = mostCommonNote(framesBetween(frames, current.start, current.end));
    } else {
      segments.push(current);
      current = { note: frame.note, start: frame.time, end: frame.time };
    }
  }
  segments.push(current);

  state.melody = segments
    .map(s => ({ note: s.note, duration: Math.max(0.1, (s.end - s.start) / 1000), result: '-' }))
    .filter(s => s.duration >= 0.12)
    .map(s => ({ ...s, duration: Number(s.duration.toFixed(2)) }));

  if (!state.melody.length) alert('No se detectaron notas suficientemente estables. Intenta cantar más cerca del micrófono.');
  renderMelody();
}

function framesBetween(frames, start, end) {
  return frames.filter(f => f.time >= start && f.time <= end).map(f => f.note).filter(Boolean);
}

function mostCommonNote(notes) {
  const counts = notes.reduce((acc, n) => ({ ...acc, [n]: (acc[n] || 0) + 1 }), {});
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || notes[0];
}

function renderMelody(currentIndex = -1) {
  const tbody = $('melodyTable');
  tbody.innerHTML = '';
  const mode = $('voiceMode').value;
  state.melody.forEach((item, index) => {
    const tr = document.createElement('tr');
    if (index === currentIndex) tr.classList.add('current-row');
    const harmony = getRelativeVoice(item.note, mode) || 'Sin regla';
    tr.innerHTML = `
      <td>${index + 1}</td>
      <td><select data-index="${index}" data-field="note">${naturalNoteOptions(item.note)}</select></td>
      <td><input data-index="${index}" data-field="duration" type="number" min="0.1" step="0.05" value="${item.duration}"></td>
      <td>${harmony}</td>
      <td class="${resultClass(item.result)}">${item.result || '-'}</td>
      <td><button class="secondary" data-action="delete" data-index="${index}">Borrar</button></td>
    `;
    tbody.appendChild(tr);
  });
}

function naturalNoteOptions(selected) {
  const octaves = [2, 3, 4, 5, 6];
  return octaves.flatMap(o => naturalNotes.map(n => `${n}${o}`))
    .map(n => `<option value="${n}" ${n === selected ? 'selected' : ''}>${displayNote(n)}</option>`).join('');
}

function displayNote(note) {
  return note.replace('C', 'DO').replace('D', 'RE').replace('E', 'MI').replace('F', 'FA').replace('G', 'SOL').replace('A', 'LA').replace('B', 'SI');
}

function resultClass(result) {
  if (!result) return '';
  if (result.includes('Afinado')) return 'result-ok';
  if (result.includes('bajo')) return 'result-low';
  if (result.includes('alto')) return 'result-high';
  return 'result-bad';
}

function getTimelineIndex(elapsed) {
  let cursor = 0;
  for (let i = 0; i < state.melody.length; i++) {
    cursor += state.melody[i].duration;
    if (elapsed <= cursor) return i;
  }
  return -1;
}

function updatePractice(freq) {
  const elapsed = (performance.now() - state.practiceStart) / 1000;
  const index = getTimelineIndex(elapsed);
  renderMelody(index);
  if (index < 0) return stopPractice();

  const target = getRelativeVoice(state.melody[index].note, $('voiceMode').value);
  const targetFreq = midiToFrequency(noteToMidi(target));
  const sungNote = frequencyToNote(freq, 'chromatic');
  const cents = freq ? centsOff(freq, targetFreq) : null;

  $('targetNote').textContent = displayNote(target);
  $('targetFreq').textContent = `${targetFreq.toFixed(1)} Hz`;
  $('practiceNote').textContent = sungNote ? displayNote(sungNote) : '--';
  $('practiceFreq').textContent = freq ? `${freq.toFixed(1)} Hz` : '-- Hz';
  $('centsDiff').textContent = cents === null ? '--' : `${cents > 0 ? '+' : ''}${cents.toFixed(0)} cents`;

  let status = '--';
  if (cents !== null) {
    if (Math.abs(cents) <= 20) status = 'Afinado';
    else if (cents < 0) status = 'Estás bajo';
    else status = 'Estás alto';
    state.melody[index].result = status;
    const left = Math.max(0, Math.min(100, 50 + cents));
    $('tunerNeedle').style.left = `${left}%`;
  }
  $('tuningStatus').textContent = status;
}

async function playMelody(type) {
  const ctx = new AudioContext();
  let when = ctx.currentTime + 0.1;
  const mode = $('voiceMode').value;
  state.melody.forEach(item => {
    const note = type === 'harmony' ? getRelativeVoice(item.note, mode) : item.note;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = midiToFrequency(noteToMidi(note));
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(0.18, when + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + item.duration - 0.03);
    osc.connect(gain).connect(ctx.destination);
    osc.start(when);
    osc.stop(when + item.duration);
    when += item.duration;
  });
}

async function startPractice() {
  await ensureAudio();
  state.practicing = true;
  state.practiceStart = performance.now();
  state.melody.forEach(m => m.result = '-');
  $('startPractice').disabled = true;
  $('stopPractice').disabled = false;
  if (!state.raf) updateLivePitch();
}

function stopPractice() {
  state.practicing = false;
  $('startPractice').disabled = false;
  $('stopPractice').disabled = true;
  renderMelody();
}

function saveSong() {
  localStorage.setItem('nortenoVoiceTrainerSong', JSON.stringify(getSongData()));
  alert('Canción guardada en este navegador.');
}

function loadSong() {
  const raw = localStorage.getItem('nortenoVoiceTrainerSong');
  if (!raw) return alert('No hay una canción guardada en este navegador.');
  setSongData(JSON.parse(raw));
}

function getSongData() {
  return {
    title: $('songTitle').value,
    voiceMode: $('voiceMode').value,
    quantizeMode: $('quantizeMode').value,
    melody: state.melody.map(({ note, duration }) => ({ note, duration }))
  };
}

function setSongData(data) {
  $('songTitle').value = data.title || 'Ejercicio norteño';
  $('voiceMode').value = data.voiceMode || 'low';
  $('quantizeMode').value = data.quantizeMode || 'natural';
  state.melody = Array.isArray(data.melody) ? data.melody.map(m => ({ ...m, result: '-' })) : [];
  renderMelody();
}

function exportSong() {
  const blob = new Blob([JSON.stringify(getSongData(), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${$('songTitle').value.replace(/[^a-z0-9_-]+/gi, '-').toLowerCase() || 'cancion'}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function bindEvents() {
  $('startRecording').addEventListener('click', async () => {
    await ensureAudio();
    state.recordedFrames = [];
    state.recording = true;
    $('startRecording').disabled = true;
    $('stopRecording').disabled = false;
    if (!state.raf) updateLivePitch();
  });

  $('stopRecording').addEventListener('click', () => {
    state.recording = false;
    $('startRecording').disabled = false;
    $('stopRecording').disabled = true;
    processRecording();
  });

  $('clearMelody').addEventListener('click', () => { state.melody = []; renderMelody(); });
  $('playLead').addEventListener('click', () => playMelody('lead'));
  $('playHarmony').addEventListener('click', () => playMelody('harmony'));
  $('startPractice').addEventListener('click', startPractice);
  $('stopPractice').addEventListener('click', stopPractice);
  $('saveSong').addEventListener('click', saveSong);
  $('loadSong').addEventListener('click', loadSong);
  $('exportSong').addEventListener('click', exportSong);
  $('addNote').addEventListener('click', () => { state.melody.push({ note: 'D4', duration: 0.5, result: '-' }); renderMelody(); });
  $('voiceMode').addEventListener('change', () => renderMelody());

  $('melodyTable').addEventListener('input', (event) => {
    const target = event.target;
    const index = Number(target.dataset.index);
    const field = target.dataset.field;
    if (!Number.isFinite(index) || !field) return;
    state.melody[index][field] = field === 'duration' ? Number(target.value) : target.value;
    renderMelody();
  });

  $('melodyTable').addEventListener('click', (event) => {
    if (event.target.dataset.action === 'delete') {
      state.melody.splice(Number(event.target.dataset.index), 1);
      renderMelody();
    }
  });

  $('importSong').addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    setSongData(JSON.parse(await file.text()));
    event.target.value = '';
  });
}

bindEvents();
renderMelody();
