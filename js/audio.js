let mediaRecorder;
let audioChunks = [];
let isRecording = false;
let timerInterval;
let secondsRecorded = 0;
let currentAudioBase64 = null;

export async function toggleRecording() {
  const btn = document.getElementById('recordBtn');
  const timerDiv = document.getElementById('recordTimer');
  const audioPreview = document.getElementById('audioPreview');

  if (!isRecording) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorder = new MediaRecorder(stream);
      audioChunks = [];

      mediaRecorder.ondataavailable = event => audioChunks.push(event.data);
      mediaRecorder.onstop = () => {
        const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
        const reader = new FileReader();
        reader.readAsDataURL(audioBlob);
        reader.onloadend = () => {
          currentAudioBase64 = reader.result;
          audioPreview.src = currentAudioBase64;
          audioPreview.style.display = 'block';
        };
      };

      mediaRecorder.start();
      isRecording = true;
      btn.classList.add('recording');
      btn.querySelector('span').innerText = '⏹️ Zaustavi snimanje';
      timerDiv.style.display = 'block';
      
      secondsRecorded = 0;
      timerInterval = setInterval(() => {
        secondsRecorded++;
        const mins = String(Math.floor(secondsRecorded / 60)).padStart(2, '0');
        const secs = String(secondsRecorded % 60).padStart(2, '0');
        document.getElementById('timerVal').innerText = `${mins}:${secs}`;
      }, 1000);

    } catch (err) {
      alert('Omogućite pristup mikrofonu u pregledniku.');
    }
  } else {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }
    isRecording = false;
    clearInterval(timerInterval);
    btn.classList.remove('recording');
    btn.querySelector('span').innerText = '🔄 Snimi ponovo';
    timerDiv.style.display = 'none';
  }
}

export function getCurrentAudio() {
  return currentAudioBase64;
}

export function resetAudioState() {
  currentAudioBase64 = null;
  const audioPreview = document.getElementById('audioPreview');
  if (audioPreview) audioPreview.style.display = 'none';
  const btn = document.getElementById('recordBtn');
  if (btn) btn.querySelector('span').innerText = '🎙️ Snimi glasovnu bilješku';
}