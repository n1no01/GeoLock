import { showToast } from './toast.js';

const MAX_RECORDING_SECONDS = 10 * 60;
const PREFERRED_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/ogg'];

let mediaRecorder = null;
let stream = null;
let chunks = [];
let isRecording = false;
let timerInterval = null;
let secondsRecorded = 0;
let currentAudio = null; // { blob, mime }
let previewUrl = null;

/** Safari/iOS ne podržava webm, pa biramo prvi podržani tip umjesto fiksnog audio/webm. */
function pickMimeType() {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return '';
  return PREFERRED_TYPES.find((t) => MediaRecorder.isTypeSupported(t)) || '';
}

function releaseStream() {
  // Bez ovoga mikrofon ostaje aktivan (indikator u pregledniku) i nakon snimanja
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
}

function setPreview(blob) {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = blob ? URL.createObjectURL(blob) : null;
  const audioPreview = document.getElementById('audioPreview');
  if (!audioPreview) return;
  if (previewUrl) {
    audioPreview.src = previewUrl;
    audioPreview.hidden = false;
  } else {
    audioPreview.removeAttribute('src');
    audioPreview.hidden = true;
  }
}

function setButtonLabel(text) {
  const label = document.getElementById('recordBtn')?.querySelector('span');
  if (label) label.textContent = text;
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  isRecording = false;
  clearInterval(timerInterval);
  document.getElementById('recordBtn')?.classList.remove('recording');
  const timerDiv = document.getElementById('recordTimer');
  if (timerDiv) timerDiv.hidden = true;
  setButtonLabel('🔄 Snimi ponovo');
}

export async function toggleRecording() {
  if (isRecording) {
    stopRecording();
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    showToast('Snimanje zvuka nije podržano u ovom pregledniku.', 'error');
    return;
  }

  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    showToast('Omogućite pristup mikrofonu u pregledniku.', 'error');
    return;
  }

  const mimeType = pickMimeType();
  mediaRecorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
  chunks = [];

  mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
  mediaRecorder.onstop = () => {
    releaseStream();
    const mime = mediaRecorder.mimeType || mimeType || 'audio/webm';
    const blob = new Blob(chunks, { type: mime });
    chunks = [];
    if (blob.size === 0) return;
    currentAudio = { blob, mime };
    setPreview(blob);
  };

  mediaRecorder.start();
  isRecording = true;
  document.getElementById('recordBtn')?.classList.add('recording');
  setButtonLabel('⏹️ Zaustavi snimanje');
  const timerDiv = document.getElementById('recordTimer');
  if (timerDiv) timerDiv.hidden = false;

  secondsRecorded = 0;
  timerInterval = setInterval(() => {
    secondsRecorded++;
    const mins = String(Math.floor(secondsRecorded / 60)).padStart(2, '0');
    const secs = String(secondsRecorded % 60).padStart(2, '0');
    const val = document.getElementById('timerVal');
    if (val) val.textContent = `${mins}:${secs}`;
    if (secondsRecorded >= MAX_RECORDING_SECONDS) {
      stopRecording();
      showToast('Dostignuto je maksimalno trajanje snimka (10 min).', 'info');
    }
  }, 1000);
}

/** { blob, mime } ili null */
export function getCurrentAudio() {
  return currentAudio;
}

export function resetAudioState() {
  if (isRecording) {
    // otkaži snimanje bez čuvanja
    mediaRecorder.onstop = () => releaseStream();
    stopRecording();
  }
  releaseStream();
  currentAudio = null;
  setPreview(null);
  setButtonLabel('🎙️ Snimi glasovnu bilješku');
}
