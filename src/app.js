const noteToSemitone = {
  C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5,
  'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11
};
const semitoneToNote = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const naturalNotes = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const solfege = { C: 'DO', 'C#': 'DO#', D: 'RE', 'D#': 'RE#', E: 'MI', F: 'FA', 'F#': 'FA#', G: 'SOL', 'G#': 'SOL#', A: 'LA', 'A#': 'LA#', B: 'SI' };
const songStorageKey = 'voiceTrainerSong';
const pitchConfig = {
  bufferSize: 2048,
  minFrequency: 70,
  maxFrequency: 1000,
  minRms: 0.012
};
const vadConfig = {
  sampleRate: 16000,
  hopSize: 256,
  voiceThreshold: 0.5,
  minVoiceProbability: 0.45,
  moduleUrl: 'https://cdn.jsdelivr.net/npm/ten-vad-lib@1.0.0/dist/index.esm.js',
  wasmPath: 'https://cdn.jsdelivr.net/npm/ten-vad-lib@1.0.0/wasm/ten_vad.wasm',
  jsPath: 'https://cdn.jsdelivr.net/npm/ten-vad-lib@1.0.0/wasm/ten_vad.js'
};
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
  pitchBuffer: [],
  pitchEngine: {
    backend: 'local',
    aubioPromise: null,
    aubioPitch: null,
    aubioSampleRate: null,
    aubioBufferSize: null,
    failure: null
  },
  vadEngine: {
    backend: 'rms',
    loaderPromise: null,
    moduleApi: null,
    wasmModule: null,
    instance: null,
    inputSampleRate: null,
    frameBuffer: [],
    speaking: true,
    probability: 1,
    failure: null
  },
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

function frequencyToNote(freq, quantizeMode = 'chromatic') {
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

function setMicHint(message, type = '') {
  const hint = $('micHint');
  hint.textContent = message;
  hint.classList.toggle('error', type === 'error');
  hint.classList.toggle('ok', type === 'ok');
}

function describeMicError(error) {
  if (!navigator.mediaDevices?.getUserMedia) {
    return 'Este navegador no expone el micrófono aquí. Abre la app en Chrome/Edge/Firefox usando http://localhost:8000.';
  }
  if (!window.isSecureContext) {
    return 'El micrófono solo funciona en localhost o HTTPS. Abre http://localhost:8000 en este mismo equipo.';
  }
  if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') {
    return 'El navegador bloqueó el micrófono. Actívalo en el icono de permisos de la barra de direcciones y vuelve a intentar.';
  }
  if (error?.name === 'NotFoundError' || error?.name === 'DevicesNotFoundError') {
    return 'No encontré un micrófono disponible. Revisa que esté conectado y seleccionado en el sistema.';
  }
  if (error?.name === 'NotReadableError' || error?.name === 'TrackStartError') {
    return 'El micrófono está ocupado por otra app o el sistema no lo dejó iniciar. Cierra otras apps de audio y prueba otra vez.';
  }
  return `No pude iniciar el micrófono: ${error?.message || error?.name || 'error desconocido'}.`;
}

async function refreshMicDevices() {
  const select = $('micDevice');
  const selected = select.value;
  select.innerHTML = '<option value="">Dispositivo predeterminado</option>';

  if (!navigator.mediaDevices?.enumerateDevices) {
    setMicHint('Este navegador no permite listar micrófonos aquí.', 'error');
    return [];
  }

  const devices = await navigator.mediaDevices.enumerateDevices();
  const inputs = devices.filter(device => device.kind === 'audioinput');

  inputs.forEach((device, index) => {
    const option = document.createElement('option');
    option.value = device.deviceId;
    option.textContent = device.label || `Micrófono ${index + 1}`;
    option.selected = device.deviceId === selected;
    select.appendChild(option);
  });

  if (!inputs.length) {
    setMicHint('El navegador no ve micrófonos. Revisa permisos del sistema o conecta uno y pulsa Actualizar.', 'error');
  } else {
    setMicHint(`Micrófonos detectados: ${inputs.length}. Elige uno o usa el predeterminado.`, 'ok');
  }

  return inputs;
}

async function ensureAudio() {
  if (state.audioContext && state.audioContext.state === 'suspended') {
    await state.audioContext.resume();
  }
  if (state.audioContext && state.analyser) return;

  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('getUserMedia no disponible');
  }

  $('micStatus').textContent = 'Pidiendo micrófono...';
  setMicHint('Esperando permiso del navegador para usar el micrófono.');

  const deviceId = $('micDevice').value;
  state.stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
      ...(deviceId ? { deviceId: { exact: deviceId } } : {})
    }
  });

  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) throw new Error('AudioContext no disponible');

  state.audioContext = new AudioContextClass();
  if (state.audioContext.state === 'suspended') await state.audioContext.resume();

  const source = state.audioContext.createMediaStreamSource(state.stream);
  state.analyser = state.audioContext.createAnalyser();
  state.analyser.fftSize = pitchConfig.bufferSize;
  source.connect(state.analyser);
  await Promise.all([ensurePitchEngine(), ensureVadEngine()]);
  $('micStatus').textContent = 'Micrófono activo';
  await refreshMicDevices();
  const pitchBackend = state.pitchEngine.backend === 'aubio' ? 'aubio yinfft' : 'detector local';
  const vadBackend = state.vadEngine.backend === 'ten' ? 'TEN VAD' : 'RMS';
  setMicHint(`Micrófono activo. Voz: ${vadBackend}. Pitch: ${pitchBackend}.`, 'ok');
}

async function ensurePitchEngine() {
  if (!state.audioContext || !state.analyser) return false;

  const sampleRate = state.audioContext.sampleRate;
  const bufferSize = state.analyser.fftSize;

  if (
    state.pitchEngine.aubioPitch &&
    state.pitchEngine.aubioSampleRate === sampleRate &&
    state.pitchEngine.aubioBufferSize === bufferSize
  ) {
    state.pitchEngine.backend = 'aubio';
    return true;
  }

  if (typeof window.aubio !== 'function') {
    state.pitchEngine.backend = 'local';
    state.pitchEngine.failure = 'aubiojs no esta cargado';
    return false;
  }

  if (!state.pitchEngine.aubioPromise) {
    state.pitchEngine.aubioPromise = window.aubio()
      .then(({ Pitch }) => {
        state.pitchEngine.aubioPitch = new Pitch('yinfft', bufferSize, bufferSize, sampleRate);
        state.pitchEngine.aubioSampleRate = sampleRate;
        state.pitchEngine.aubioBufferSize = bufferSize;
        state.pitchEngine.backend = 'aubio';
        state.pitchEngine.failure = null;
        return true;
      })
      .catch((error) => {
        console.warn('No se pudo iniciar aubiojs, usando detector local:', error);
        state.pitchEngine.backend = 'local';
        state.pitchEngine.aubioPitch = null;
        state.pitchEngine.failure = error?.message || 'aubiojs no disponible';
        return false;
      })
      .finally(() => {
        state.pitchEngine.aubioPromise = null;
      });
  }

  return state.pitchEngine.aubioPromise;
}

async function ensureVadEngine() {
  if (!state.audioContext) return false;

  if (state.vadEngine.instance && state.vadEngine.inputSampleRate === state.audioContext.sampleRate) {
    state.vadEngine.backend = 'ten';
    return true;
  }

  if (!state.vadEngine.loaderPromise) {
    state.vadEngine.loaderPromise = import(vadConfig.moduleUrl)
      .then(async (api) => {
        const module = await api.VADModuleLoader.getInstance().loadModule({
          wasmPath: vadConfig.wasmPath,
          jsPath: vadConfig.jsPath
        });
        state.vadEngine.instance?.destroy();
        state.vadEngine.moduleApi = api;
        state.vadEngine.wasmModule = module;
        state.vadEngine.instance = new api.VADInstance(module, vadConfig.hopSize, vadConfig.voiceThreshold);
        state.vadEngine.inputSampleRate = state.audioContext.sampleRate;
        state.vadEngine.backend = 'ten';
        state.vadEngine.failure = null;
        resetVadState();
        return true;
      })
      .catch((error) => {
        console.warn('No se pudo iniciar TEN VAD, usando puerta RMS:', error);
        state.vadEngine.backend = 'rms';
        state.vadEngine.failure = error?.message || 'TEN VAD no disponible';
        return false;
      })
      .finally(() => {
        state.vadEngine.loaderPromise = null;
      });
  }

  return state.vadEngine.loaderPromise;
}

function resetVadState() {
  state.vadEngine.frameBuffer = [];
  state.vadEngine.speaking = true;
  state.vadEngine.probability = 1;
  try {
    state.vadEngine.instance?.reset();
  } catch (error) {
    console.warn('No se pudo reiniciar TEN VAD:', error);
  }
}

function median(values) {
  const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.floor(sorted.length / 2)];
}

function smoothPitch(freq) {
  if (!freq) {
    state.pitchBuffer = [];
    return null;
  }
  state.pitchBuffer.push(freq);
  if (state.pitchBuffer.length > 5) state.pitchBuffer.shift();
  const midis = state.pitchBuffer.map(frequencyToMidi);
  const medianMidi = median(midis);
  if (medianMidi === null) return freq;
  const nearby = state.pitchBuffer.filter(f => Math.abs(frequencyToMidi(f) - medianMidi) <= 1);
  return median(nearby) || freq;
}

function parabolicPeak(values, index) {
  const left = values[index - 1] ?? values[index];
  const center = values[index];
  const right = values[index + 1] ?? values[index];
  const denominator = left - (2 * center) + right;
  if (!denominator) return index;
  return index + ((left - right) / (2 * denominator));
}

function detectPitchMpm(buffer, sampleRate) {
  const cutoff = 0.9;
  const minPeriod = Math.floor(sampleRate / pitchConfig.maxFrequency);
  const maxPeriod = Math.min(Math.floor(sampleRate / pitchConfig.minFrequency), Math.floor(buffer.length / 2));
  const nsdf = new Float32Array(maxPeriod + 1);

  let mean = 0;
  for (const sample of buffer) mean += sample;
  mean /= buffer.length;

  for (let tau = 0; tau <= maxPeriod; tau++) {
    let acf = 0;
    let divisor = 0;
    for (let i = 0; i < buffer.length - tau; i++) {
      const a = buffer[i] - mean;
      const b = buffer[i + tau] - mean;
      acf += a * b;
      divisor += (a * a) + (b * b);
    }
    nsdf[tau] = divisor ? (2 * acf) / divisor : 0;
  }

  let bestPeriod = -1;
  let bestValue = 0;
  let searchingPeak = false;

  for (let tau = minPeriod; tau <= maxPeriod; tau++) {
    if (nsdf[tau] > 0 && nsdf[tau - 1] <= 0) searchingPeak = true;
    if (!searchingPeak) continue;

    const isPeak = nsdf[tau] > nsdf[tau - 1] && nsdf[tau] >= (nsdf[tau + 1] ?? -1);
    if (isPeak && nsdf[tau] > bestValue) {
      bestValue = nsdf[tau];
      bestPeriod = tau;
      if (bestValue >= cutoff) break;
    }

    if (nsdf[tau] <= 0) searchingPeak = false;
  }

  if (bestPeriod < 0 || bestValue < 0.78) return null;
  const refinedPeriod = parabolicPeak(nsdf, bestPeriod);
  if (!Number.isFinite(refinedPeriod) || refinedPeriod <= 0) return null;
  return sampleRate / refinedPeriod;
}

function detectPitchAubio(buffer) {
  const pitch = state.pitchEngine.aubioPitch?.do(buffer);
  if (!Number.isFinite(pitch) || pitch < pitchConfig.minFrequency || pitch > pitchConfig.maxFrequency) {
    return null;
  }
  return pitch;
}

function downsampleToVadFrameData(buffer, sampleRate) {
  if (sampleRate === vadConfig.sampleRate) {
    const samples = new Int16Array(buffer.length);
    for (let i = 0; i < buffer.length; i++) {
      const clamped = Math.max(-1, Math.min(1, buffer[i]));
      samples[i] = Math.round(clamped * 32767);
    }
    return samples;
  }

  const ratio = sampleRate / vadConfig.sampleRate;
  const outputLength = Math.max(1, Math.floor(buffer.length / ratio));
  const samples = new Int16Array(outputLength);

  for (let i = 0; i < outputLength; i++) {
    const sourceIndex = i * ratio;
    const leftIndex = Math.floor(sourceIndex);
    const rightIndex = Math.min(buffer.length - 1, leftIndex + 1);
    const mix = sourceIndex - leftIndex;
    const sample = (buffer[leftIndex] * (1 - mix)) + (buffer[rightIndex] * mix);
    const clamped = Math.max(-1, Math.min(1, sample));
    samples[i] = Math.round(clamped * 32767);
  }

  return samples;
}

async function detectVoiceActivity(buffer, rms, sampleRate) {
  if (state.vadEngine.backend !== 'ten' || !state.vadEngine.instance) {
    state.vadEngine.speaking = rms >= pitchConfig.minRms;
    state.vadEngine.probability = state.vadEngine.speaking ? 1 : 0;
    return state.vadEngine.speaking;
  }

  const vadSamples = downsampleToVadFrameData(buffer, sampleRate);
  for (const sample of vadSamples) state.vadEngine.frameBuffer.push(sample);

  let processedFrames = 0;
  let strongestProbability = 0;
  let voiceDetected = false;

  while (state.vadEngine.frameBuffer.length >= vadConfig.hopSize) {
    const frame = Int16Array.from(state.vadEngine.frameBuffer.slice(0, vadConfig.hopSize));
    state.vadEngine.frameBuffer = state.vadEngine.frameBuffer.slice(vadConfig.hopSize);
    const result = await state.vadEngine.instance.processFrame(frame);
    processedFrames++;
    strongestProbability = Math.max(strongestProbability, result.probability || 0);
    voiceDetected = voiceDetected || result.isVoice || result.probability >= vadConfig.minVoiceProbability;
  }

  if (processedFrames > 0) {
    state.vadEngine.probability = strongestProbability;
    state.vadEngine.speaking = voiceDetected;
  }

  return state.vadEngine.speaking;
}

async function detectPitch(analyser, audioContext) {
  const buffer = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(buffer);

  let rms = 0;
  for (const sample of buffer) rms += sample * sample;
  rms = Math.sqrt(rms / buffer.length);
  $('volumeBar').style.width = `${Math.min(100, rms * 700)}%`;
  if (rms < pitchConfig.minRms) return { freq: null, rms };
  if (!await detectVoiceActivity(buffer, rms, audioContext.sampleRate)) return { freq: null, rms };

  const freq = state.pitchEngine.backend === 'aubio'
    ? detectPitchAubio(buffer)
    : detectPitchMpm(buffer, audioContext.sampleRate);
  return { freq: smoothPitch(freq), rms };
}

async function updateLivePitch() {
  if (!state.analyser || !state.audioContext) return;
  const { freq } = await detectPitch(state.analyser, state.audioContext);
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
    state.activeRecordingSegment = { note: detected, start: now, end: now, lastSeen: now, freqs: [freq] };
    return;
  }

  if (state.activeRecordingSegment.note === detected) {
    state.activeRecordingSegment.end = now;
    state.activeRecordingSegment.lastSeen = now;
    if (freq) state.activeRecordingSegment.freqs.push(freq);
    return;
  }

  const previousDuration = state.activeRecordingSegment.end - state.activeRecordingSegment.start;
  if (previousDuration < 120) {
    state.activeRecordingSegment.note = detected;
    state.activeRecordingSegment.end = now;
    state.activeRecordingSegment.lastSeen = now;
    if (freq) state.activeRecordingSegment.freqs.push(freq);
    return;
  }

  finishActiveRecordingSegment();
  state.activeRecordingSegment = { note: detected, start: now, end: now, lastSeen: now, freqs: [freq] };
}

function finishActiveRecordingSegment() {
  if (!state.activeRecordingSegment) return;
  const durationMs = state.activeRecordingSegment.end - state.activeRecordingSegment.start;
  if (durationMs >= 120) {
    const freq = median(state.activeRecordingSegment.freqs || []);
    const note = frequencyToNote(freq) || state.activeRecordingSegment.note;
    state.recordingSegments.push({ ...state.activeRecordingSegment, note });
  }
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
  if (state.melody.length) $('visualGuide').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function noteOptions(selected) {
  const octaves = [2, 3, 4, 5, 6];
  return octaves.flatMap(o => semitoneToNote.map(n => `${n}${o}`))
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
      <td><select data-index="${index}" data-field="note">${noteOptions(item.note)}</select></td>
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
  let cue = 'Canta la segunda voz y observa la aguja.';
  if (cents !== null) {
    if (Math.abs(cents) <= 20) {
      status = 'Afinado';
      cue = 'Mantén la nota: estás en el centro.';
    } else if (cents < 0) {
      status = 'Estás bajo';
      cue = 'Sube un poco la voz hasta acercar la aguja al centro.';
    } else {
      status = 'Estás alto';
      cue = 'Baja un poco la voz hasta acercar la aguja al centro.';
    }
    state.melody[index].result = status;
    const left = Math.max(0, Math.min(100, 50 + cents));
    $('tunerNeedle').style.left = `${left}%`;
  }
  $('tuningStatus').textContent = status;
  $('tuningCue').textContent = cue;
}

function resetPracticeReadout() {
  $('targetNote').textContent = '--';
  $('targetFreq').textContent = '-- Hz';
  $('practiceNote').textContent = '--';
  $('practiceFreq').textContent = '-- Hz';
  $('centsDiff').textContent = '--';
  $('tuningStatus').textContent = '--';
  $('tuningCue').textContent = 'Pulsa practicar, canta la segunda voz y lleva la aguja al centro.';
  $('tunerNeedle').style.left = '50%';
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
  const attack = Math.min(0.06, Math.max(0.025, duration * 0.18));
  const release = Math.min(0.14, duration * 0.35);
  const stopAt = start + duration + release + 0.03;

  const noteGain = ctx.createGain();
  const lowpass = ctx.createBiquadFilter();

  lowpass.type = 'lowpass';
  lowpass.frequency.setValueAtTime(1800, start);
  lowpass.Q.value = 0.4;
  noteGain.connect(lowpass).connect(destination);

  noteGain.gain.setValueAtTime(0, start);
  noteGain.gain.linearRampToValueAtTime(0.18, start + attack);
  noteGain.gain.setValueAtTime(0.18, Math.max(start + attack, start + duration - release));
  noteGain.gain.linearRampToValueAtTime(0, start + duration + release);

  const vibratoOsc = ctx.createOscillator();
  const vibratoGain = ctx.createGain();
  vibratoOsc.type = 'sine';
  vibratoOsc.frequency.setValueAtTime(4.8, start);
  vibratoGain.gain.setValueAtTime(0, start);
  vibratoGain.gain.linearRampToValueAtTime(1.8, start + Math.min(0.3, duration * 0.5));
  vibratoOsc.connect(vibratoGain);

  const voices = [
    { type: 'sine', gain: 0.18, detune: 0, ratio: 1 },
    { type: 'triangle', gain: 0.055, detune: -2, ratio: 1 },
    { type: 'sine', gain: 0.02, detune: 0, ratio: 2 }
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
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return;
  const ctx = new AudioContextClass();
  if (ctx.state === 'suspended') await ctx.resume();

  const master = ctx.createGain();
  master.gain.value = 0.92;
  master.connect(ctx.destination);
  const createBus = (gainValue, panValue = 0) => {
    const gain = ctx.createGain();
    gain.gain.value = gainValue;
    if (ctx.createStereoPanner) {
      const pan = ctx.createStereoPanner();
      pan.pan.value = panValue;
      gain.connect(pan).connect(master);
    } else {
      gain.connect(master);
    }
    return gain;
  };

  const leadBus = createBus(type === 'both' ? 0.54 : 0.88, type === 'both' ? -0.18 : 0);
  const harmonyBus = createBus(type === 'both' ? 0.78 : 0.88, type === 'both' ? 0.18 : 0);

  let when = ctx.currentTime + 0.08;
  const mode = $('voiceMode').value;

  beginPlaybackVisualization(type);

  state.melody.forEach(item => {
    const duration = Math.max(0.15, Number(item.duration) || 0.15);
    const leadNote = item.note;
    const harmonyNote = getRelativeVoice(item.note, mode);

    if ((type === 'lead' || type === 'both') && leadNote) {
      createVoiceTone(ctx, leadBus, midiToFrequency(noteToMidi(leadNote)), when, duration);
    }

    if ((type === 'harmony' || type === 'both') && harmonyNote) {
      createVoiceTone(ctx, harmonyBus, midiToFrequency(noteToMidi(harmonyNote)), when, duration);
    }

    when += duration;
  });

  window.setTimeout(() => {
    state.playback.active = false;
    ctx.close();
  }, Math.max(0, (when - ctx.currentTime + 0.25) * 1000));
}

async function startPractice() {
  if (!state.melody.length) return;
  try {
    $('startPractice').disabled = true;
    await ensureAudio();
    state.pitchBuffer = [];
    resetVadState();
    resetPracticeReadout();
    state.practicing = true;
    state.practiceStart = performance.now();
    state.practiceTrace = [];
    state.currentPracticeIndex = 0;
    state.melody.forEach(m => m.result = '-');
    $('stopPractice').disabled = false;
    if (!state.raf) updateLivePitch();
    updatePractice(null);
    document.querySelector('.practice-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    renderMelody();
  } catch (error) {
    console.error(error);
    state.practicing = false;
    $('micStatus').textContent = 'Micrófono bloqueado';
    $('startPractice').disabled = false;
    $('stopPractice').disabled = true;
    setMicHint(describeMicError(error), 'error');
  }
}

function stopPractice() {
  state.practicing = false;
  state.currentPracticeIndex = -1;
  $('startPractice').disabled = false;
  $('stopPractice').disabled = true;
  resetPracticeReadout();
  renderMelody();
}

function saveSong() {
  localStorage.setItem(songStorageKey, JSON.stringify(getSongData()));
  alert('Canción guardada en este navegador.');
}

function loadSong() {
  const raw = localStorage.getItem(songStorageKey);
  if (!raw) return alert('No hay una canción guardada en este navegador.');
  setSongData(JSON.parse(raw));
}

function getSongData() {
  return {
    title: $('songTitle').value,
    voiceMode: $('voiceMode').value,
    melody: state.melody.map(({ note, duration }) => ({ note, duration }))
  };
}

function setSongData(data) {
  $('songTitle').value = data.title || 'Ejercicio de voz';
  $('voiceMode').value = data.voiceMode || 'low';
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
  const compactChart = window.matchMedia('(max-width: 520px)').matches;
  const height = compactChart ? 300 : 340;
  const pad = compactChart
    ? { left: 50, right: 10, top: 18, bottom: 22 }
    : { left: 64, right: 16, top: 18, bottom: 28 };
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
  const chartNotes = compactChart ? '' : `
    <rect x="${width - 220}" y="16" rx="12" ry="12" width="190" height="30" class="chart-note-chip" />
    <text x="${width - 205}" y="36" class="chart-note-text">${escapeHtml(chipText)}</text>
    <text x="${pad.left}" y="18" class="chart-note-text">Principal: ${escapeHtml(leadStart)}</text>
    <text x="${pad.left + 150}" y="18" class="chart-note-text">Segunda: ${escapeHtml(targetStart)}</text>
  `;

  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);

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
    ${chartNotes}
  `;
}

function bindEvents() {
  $('refreshMics').addEventListener('click', async () => {
    try {
      await refreshMicDevices();
    } catch (error) {
      console.error(error);
      setMicHint(describeMicError(error), 'error');
    }
  });

  $('startRecording').addEventListener('click', async () => {
    try {
      $('startRecording').disabled = true;
      await ensureAudio();
      state.pitchBuffer = [];
      resetVadState();
      state.recordedFrames = [];
      state.recordingSegments = [];
      state.activeRecordingSegment = null;
      state.recording = true;
      $('stopRecording').disabled = false;
      if (!state.raf) updateLivePitch();
    } catch (error) {
      console.error(error);
      state.recording = false;
      $('micStatus').textContent = 'Micrófono bloqueado';
      $('startRecording').disabled = false;
      $('stopRecording').disabled = true;
      setMicHint(describeMicError(error), 'error');
    }
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
  $('playBoth').addEventListener('click', () => playMelody('both'));
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
refreshMicDevices().catch(() => {
  setMicHint('Pulsa Actualizar o Iniciar grabación para comprobar el micrófono.', '');
});
renderMelody();
