const noteToSemitone = {
  C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5,
  'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11
};
const semitoneToNote = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const naturalNotes = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const solfege = { C: 'DO', 'C#': 'DO#', D: 'RE', 'D#': 'RE#', E: 'MI', F: 'FA', 'F#': 'FA#', G: 'SOL', 'G#': 'SOL#', A: 'LA', 'A#': 'LA#', B: 'SI' };
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
  recordingSegments: [],
  activeRecordingSegment: null,
  melody: [
    { note: 'D4', duration: 0.5, result: '-' },
    { note: 'E4', duration: 0.5, result: '-' },
    { note: 'F4', duration: 0.5, result: '-' },
    { note: 'G4', duration: 1.0, result: '-' }
  ],
  practiceStart: 0,
  practiceTrace: [],
  currentPracticeIndex: -1,
  raf: null,
  playback: { active: false, start: 0, duration: 0, type: null },
  playbackRaf: null
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

function displayNote(note) {
  if (!note) return '--';
  const { name, octave } = parseNote(note);
  return `${solfege[name]}${octave}`;
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

function totalDuration() {
  return state.melody.reduce((sum, item) => sum + Math.max(0.1, Number(item.duration) || 0), 0);
}

async function ensureAudio() {
  if (state.audioContext && state.analyser) return;
  state.stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false }
  });
  state.audioContext = new AudioContext();
  const source = state.audioContext.createMediaStreamSource(state.stream);
  state.analyser = state.audioContext.createAnalyser();
  state.analyser.fftSize = 4096;
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
  $('liveNote').textContent = note ? displayNote(note) : '--';

  if (state.recording) collectRecordingFrame(freq);
  if (state.practicing) updatePractice(freq);

  if (state.recording || state.practicing) {
    state.raf = requestAnimationFrame(updateLivePitch);
  } else {
    state.raf = null;
  }
}

function collectRecordingFrame(freq) {
  const now = performance.now();
  const detected = frequencyToNote(freq);
  state.recordedFrames.push({ time: now, note: detected, freq });

  const maxSilentGap = 280;
  if (!detected) {
    if (state.activeRecordingSegment) {
      const gap = now - state.activeRecordingSegment.lastSeen;
      if (gap <= maxSilentGap) {
        state.activeRecordingSegment.end = now;
      } else {
        finishActiveRecordingSegment();
      }
    }
    return;
  }

  if (!state.activeRecordingSegment) {
    state.activeRecordingSegment = { note: detected, start: now, end: now, lastSeen: now };
    return;
  }

  if (state.activeRecordingSegment.note === detected) {
    state.activeRecordingSegment.end = now;
    state.activeRecordingSegment.lastSeen = now;
    return;
  }

  const previousDuration = state.activeRecordingSegment.end - state.activeRecordingSegment.start;
  if (previousDuration < 120) {
    state.activeRecordingSegment.note = detected;
    state.activeRecordingSegment.end = now;
    state.activeRecordingSegment.lastSeen = now;
    return;
  }

  finishActiveRecordingSegment();
  state.activeRecordingSegment = { note: detected, start: now, end: now, lastSeen: now };
}

function finishActiveRecordingSegment() {
  if (!state.activeRecordingSegment) return;
  const durationMs = state.activeRecordingSegment.end - state.activeRecordingSegment.start;
  if (durationMs >= 120) state.recordingSegments.push({ ...state.activeRecordingSegment });
  state.activeRecordingSegment = null;
}

function mergeShortGaps(segments) {
  if (!segments.length) return [];
  const merged = [];
  for (const segment of segments) {
    const last = merged[merged.length - 1];
    if (last && last.note === segment.note && segment.start - last.end <= 300) {
      last.end = segment.end;
      last.lastSeen = segment.lastSeen;
    } else {
      merged.push({ ...segment });
    }
  }
  return merged;
}

function processRecording() {
  finishActiveRecordingSegment();
  const segments = mergeShortGaps(state.recordingSegments);
  state.melody = segments
    .map(s => ({ note: s.note, duration: Math.max(0.15, (s.end - s.start) / 1000), result: '-' }))
    .filter(s => s.duration >= 0.15)
    .map(s => ({ ...s, duration: Number(s.duration.toFixed(2)) }));

  if (!state.melody.length) {
    alert('No se detectaron notas suficientemente estables. Intenta cantar más cerca del micrófono o subir un poco el volumen.');
  }
  renderMelody();
}

function naturalNoteOptions(selected) {
  const octaves = [2, 3, 4, 5, 6];
  return octaves.flatMap(o => naturalNotes.map(n => `${n}${o}`))
    .map(n => `<option value="${n}" ${n === selected ? 'selected' : ''}>${displayNote(n)}</option>`).join('');
}

function resultClass(result) {
  if (!result) return '';
  if (result.includes('Afinado')) return 'result-ok';
  if (result.includes('bajo')) return 'result-low';
  if (result.includes('alto')) return 'result-high';
  return 'result-bad';
}

function renderMelody() {
  const tbody = $('melodyTable');
  tbody.innerHTML = '';
  const mode = $('voiceMode').value;

  state.melody.forEach((item, index) => {
    const tr = document.createElement('tr');
    tr.dataset.rowIndex = String(index);
    const harmony = getRelativeVoice(item.note, mode) || 'Sin regla';
    tr.innerHTML = `
      <td>${index + 1}</td>
      <td><select data-index="${index}" data-field="note">${naturalNoteOptions(item.note)}</select></td>
      <td><input data-index="${index}" data-field="duration" type="number" min="0.1" step="0.05" value="${item.duration}"></td>
      <td>${harmony === 'Sin regla' ? harmony : displayNote(harmony)}</td>
      <td class="${resultClass(item.result)}">${item.result || '-'}</td>
      <td><button class="secondary" data-action="delete" data-index="${index}">Borrar</button></td>
    `;
    tbody.appendChild(tr);
  });

  highlightCurrentRow(state.currentPracticeIndex);
  renderTimelineChart();
}

function highlightCurrentRow(index) {
  document.querySelectorAll('#melodyTable tr').forEach(tr => {
    tr.classList.toggle('current-row', Number(tr.dataset.rowIndex) === index);
  });
}

function getTimelineIndex(elapsed) {
  let cursor = 0;
  for (let i = 0; i < state.melody.length; i++) {
    cursor += state.melody[i].duration;
    if (elapsed <= cursor) return i;
  }
  return -1;
}

function appendPracticeTracePoint(elapsed, freq) {
  if (!freq) return;
  const note = frequencyToNote(freq, 'chromatic');
  if (!note) return;
  state.practiceTrace.push({ t: elapsed, midi: noteToMidi(note) });
  if (state.practiceTrace.length > 1200) state.practiceTrace.shift();
}

function updatePractice(freq) {
  const elapsed = (performance.now() - state.practiceStart) / 1000;
  const index = getTimelineIndex(elapsed);
  state.currentPracticeIndex = index;
  appendPracticeTracePoint(elapsed, freq);

  highlightCurrentRow(index);
  renderTimelineChart();

  if (index < 0) {
    stopPractice();
    return;
  }

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

function beginPlaybackVisualization(type) {
  state.playback = { active: true, start: performance.now(), duration: totalDuration(), type };
  if (!state.playbackRaf) animatePlaybackVisualization();
}

function animatePlaybackVisualization() {
  if (!state.playback.active) {
    state.playbackRaf = null;
    renderTimelineChart();
    return;
  }
  const elapsed = (performance.now() - state.playback.start) / 1000;
  if (elapsed >= state.playback.duration) {
    state.playback.active = false;
    state.playbackRaf = null;
    renderTimelineChart();
    return;
  }
  renderTimelineChart();
  state.playbackRaf = requestAnimationFrame(animatePlaybackVisualization);
}

function createVoiceTone(ctx, destination, frequency, start, duration) {
  const release = Math.min(0.16, duration * 0.35);
  const attack = Math.min(0.05, Math.max(0.02, duration * 0.18));
  const decayEnd = start + Math.min(duration * 0.45, attack + 0.12);
  const stopAt = start + duration + release + 0.04;

  const noteGain = ctx.createGain();
  const highpass = ctx.createBiquadFilter();
  const lowpass = ctx.createBiquadFilter();
  const compressor = ctx.createDynamicsCompressor();

  highpass.type = 'highpass';
  highpass.frequency.setValueAtTime(110, start);
  lowpass.type = 'lowpass';
  lowpass.frequency.setValueAtTime(2600, start);
  lowpass.Q.value = 0.7;
  compressor.threshold.value = -24;
  compressor.knee.value = 18;
  compressor.ratio.value = 3;
  compressor.attack.value = 0.003;
  compressor.release.value = 0.12;

  noteGain.connect(highpass);
  highpass.connect(lowpass);
  lowpass.connect(compressor);
  compressor.connect(destination);

  noteGain.gain.setValueAtTime(0.0001, start);
  noteGain.gain.linearRampToValueAtTime(0.2, start + attack);
  noteGain.gain.linearRampToValueAtTime(0.14, decayEnd);
  noteGain.gain.setValueAtTime(0.14, start + duration);
  noteGain.gain.exponentialRampToValueAtTime(0.0001, start + duration + release);

  const vibratoOsc = ctx.createOscillator();
  const vibratoGain = ctx.createGain();
  vibratoOsc.type = 'sine';
  vibratoOsc.frequency.setValueAtTime(5.4, start);
  vibratoGain.gain.setValueAtTime(8, start);
  vibratoOsc.connect(vibratoGain);

  const voices = [
    { type: 'triangle', gain: 0.11, detune: 0, ratio: 1 },
    { type: 'sine', gain: 0.06, detune: -4, ratio: 1 },
    { type: 'sine', gain: 0.024, detune: 2, ratio: 2 }
  ];

  const oscillators = voices.map(spec => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = spec.type;
    osc.frequency.setValueAtTime(frequency * spec.ratio, start);
    osc.detune.setValueAtTime(spec.detune, start);
    vibratoGain.connect(osc.detune);
    gain.gain.setValueAtTime(spec.gain, start);
    osc.connect(gain).connect(noteGain);
    osc.start(start);
    osc.stop(stopAt);
    return osc;
  });

  vibratoOsc.start(start);
  vibratoOsc.stop(stopAt);
  return { oscillators, vibratoOsc };
}

async function playMelody(type) {
  if (!state.melody.length) return;
  const ctx = new AudioContext();
  if (ctx.state === 'suspended') await ctx.resume();

  const master = ctx.createGain();
  master.gain.value = 0.92;
  master.connect(ctx.destination);

  let when = ctx.currentTime + 0.08;
  const mode = $('voiceMode').value;

  beginPlaybackVisualization(type);

  state.melody.forEach(item => {
    const note = type === 'harmony' ? getRelativeVoice(item.note, mode) : item.note;
    if (!note) return;
    const duration = Math.max(0.15, Number(item.duration) || 0.15);
    const frequency = midiToFrequency(noteToMidi(note));
    createVoiceTone(ctx, master, frequency, when, duration);
    when += duration;
  });

  window.setTimeout(() => {
    state.playback.active = false;
    ctx.close();
  }, Math.max(0, (when - ctx.currentTime + 0.25) * 1000));
}

async function startPractice() {
  if (!state.melody.length) return;
  await ensureAudio();
  state.practicing = true;
  state.practiceStart = performance.now();
  state.practiceTrace = [];
  state.currentPracticeIndex = 0;
  state.melody.forEach(m => m.result = '-');
  $('startPractice').disabled = true;
  $('stopPractice').disabled = false;
  if (!state.raf) updateLivePitch();
  renderMelody();
}

function stopPractice() {
  state.practicing = false;
  state.currentPracticeIndex = -1;
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
  state.practiceTrace = [];
  state.currentPracticeIndex = -1;
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

function notePathData(sequence, noteAccessor, xForTime, yForMidi) {
  let cursor = 0;
  let d = '';
  let prevY = null;

  sequence.forEach((item, index) => {
    const note = noteAccessor(item);
    if (!note) {
      cursor += Number(item.duration) || 0;
      return;
    }

    const duration = Math.max(0.1, Number(item.duration) || 0.1);
    const y = yForMidi(noteToMidi(note));
    const x1 = xForTime(cursor);
    const x2 = xForTime(cursor + duration);

    if (index === 0 || prevY === null) {
      d += `M ${x1.toFixed(2)} ${y.toFixed(2)} `;
    } else {
      const corner = Math.min(12, Math.max(4, (x2 - x1) * 0.2));
      d += `L ${(x1 - corner).toFixed(2)} ${prevY.toFixed(2)} `;
      d += `Q ${x1.toFixed(2)} ${prevY.toFixed(2)} ${x1.toFixed(2)} ${y.toFixed(2)} `;
    }

    d += `L ${x2.toFixed(2)} ${y.toFixed(2)} `;
    prevY = y;
    cursor += duration;
  });

  return d.trim();
}

function livePathData(points, xForTime, yForMidi, maxDuration) {
  const filtered = points.filter(p => p.t >= 0 && p.t <= maxDuration && Number.isFinite(p.midi));
  if (!filtered.length) return '';
  let d = '';
  filtered.forEach((point, index) => {
    const x = xForTime(point.t);
    const y = yForMidi(point.midi);
    d += `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)} `;
  });
  return d.trim();
}

function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderTimelineChart() {
  const svg = $('timelineSvg');
  const empty = $('chartEmpty');
  const melody = state.melody;

  if (!melody.length) {
    svg.innerHTML = '';
    empty.style.display = 'flex';
    return;
  }

  empty.style.display = 'none';

  const width = 960;
  const height = 340;
  const pad = { left: 64, right: 16, top: 18, bottom: 28 };
  const chartWidth = width - pad.left - pad.right;
  const chartHeight = height - pad.top - pad.bottom;
  const mode = $('voiceMode').value;
  const harmonyNotes = melody.map(item => getRelativeVoice(item.note, mode)).filter(Boolean);
  const leadNotes = melody.map(item => item.note).filter(Boolean);
  const liveMidis = state.practiceTrace.map(p => p.midi).filter(Number.isFinite);
  const midis = [...leadNotes.map(noteToMidi), ...harmonyNotes.map(noteToMidi), ...liveMidis];

  const minMidi = (Math.min(...midis) || 58) - 1;
  const maxMidi = (Math.max(...midis) || 74) + 1;
  const midiRange = Math.max(1, maxMidi - minMidi);
  const total = totalDuration();

  const xForTime = (time) => pad.left + (Math.max(0, Math.min(total, time)) / total) * chartWidth;
  const yForMidi = (midi) => pad.top + ((maxMidi - midi) / midiRange) * chartHeight;

  const leadPath = notePathData(melody, item => item.note, xForTime, yForMidi);
  const harmonyPath = notePathData(melody, item => getRelativeVoice(item.note, mode), xForTime, yForMidi);
  const livePath = livePathData(state.practiceTrace, xForTime, yForMidi, total);

  let playElapsed = null;
  if (state.practicing) playElapsed = (performance.now() - state.practiceStart) / 1000;
  else if (state.playback.active) playElapsed = (performance.now() - state.playback.start) / 1000;

  const gridLines = [];
  for (let midi = maxMidi; midi >= minMidi; midi--) {
    const y = yForMidi(midi);
    const name = semitoneToNote[((midi % 12) + 12) % 12];
    const natural = naturalNotes.includes(name);
    gridLines.push(`<line x1="${pad.left}" y1="${y.toFixed(2)}" x2="${width - pad.right}" y2="${y.toFixed(2)}" class="${natural ? 'chart-grid-major' : 'chart-grid-minor'}" />`);
    if (natural) {
      gridLines.push(`<text x="14" y="${(y + 4).toFixed(2)}" class="chart-label">${escapeHtml(displayNote(midiToNote(midi)))}</text>`);
    }
  }

  const leadStart = melody[0]?.note ? displayNote(melody[0].note) : '--';
  const targetStart = harmonyNotes[0] ? displayNote(harmonyNotes[0]) : '--';

  let playheadMarkup = '';
  if (playElapsed !== null && playElapsed <= total) {
    const x = xForTime(playElapsed);
    playheadMarkup = `
      <rect x="${Math.max(pad.left, x - 12).toFixed(2)}" y="${pad.top}" width="24" height="${chartHeight}" class="chart-playhead" rx="12" />
      <line x1="${x.toFixed(2)}" y1="${pad.top}" x2="${x.toFixed(2)}" y2="${height - pad.bottom}" class="chart-playline" />
    `;
  }

  const currentIndex = state.currentPracticeIndex >= 0 ? state.currentPracticeIndex : 0;
  const currentTarget = melody[currentIndex] ? getRelativeVoice(melody[currentIndex].note, mode) : harmonyNotes[0];
  const chipText = currentTarget ? `Referencia: ${displayNote(currentTarget)}` : `Referencia: ${targetStart}`;

  svg.innerHTML = `
    <defs>
      <linearGradient id="chartBgGlow" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="rgba(255,255,255,0.04)" />
        <stop offset="100%" stop-color="rgba(255,255,255,0)" />
      </linearGradient>
    </defs>
    <rect x="0" y="0" width="${width}" height="${height}" fill="url(#chartBgGlow)" />
    ${gridLines.join('')}
    ${leadPath ? `<path d="${leadPath}" class="chart-lead" />` : ''}
    ${harmonyPath ? `<path d="${harmonyPath}" class="chart-target" />` : ''}
    ${livePath ? `<path d="${livePath}" class="chart-live" />` : ''}
    ${playheadMarkup}
    <rect x="${width - 220}" y="16" rx="12" ry="12" width="190" height="30" class="chart-note-chip" />
    <text x="${width - 205}" y="36" class="chart-note-text">${escapeHtml(chipText)}</text>
    <text x="${pad.left}" y="18" class="chart-note-text">Principal: ${escapeHtml(leadStart)}</text>
    <text x="${pad.left + 150}" y="18" class="chart-note-text">Segunda: ${escapeHtml(targetStart)}</text>
  `;
}

function bindEvents() {
  $('startRecording').addEventListener('click', async () => {
    await ensureAudio();
    state.recordedFrames = [];
    state.recordingSegments = [];
    state.activeRecordingSegment = null;
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

  $('clearMelody').addEventListener('click', () => {
    state.melody = [];
    state.practiceTrace = [];
    renderMelody();
  });

  $('playLead').addEventListener('click', () => playMelody('lead'));
  $('playHarmony').addEventListener('click', () => playMelody('harmony'));
  $('startPractice').addEventListener('click', startPractice);
  $('stopPractice').addEventListener('click', stopPractice);
  $('saveSong').addEventListener('click', saveSong);
  $('loadSong').addEventListener('click', loadSong);
  $('exportSong').addEventListener('click', exportSong);
  $('addNote').addEventListener('click', () => {
    state.melody.push({ note: 'D4', duration: 0.5, result: '-' });
    renderMelody();
  });
  $('voiceMode').addEventListener('change', renderMelody);

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
