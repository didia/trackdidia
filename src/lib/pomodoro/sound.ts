let audioContext: AudioContext | null = null;
let fallbackAudio: HTMLAudioElement | null = null;

const CHIME_SAMPLE_RATE = 44_100;
const CHIME_NOTES = [
  { frequency: 784, offsetSeconds: 0, durationSeconds: 0.16 },
  { frequency: 988, offsetSeconds: 0.2, durationSeconds: 0.16 },
  { frequency: 1175, offsetSeconds: 0.4, durationSeconds: 0.22 }
] as const;

const encodeBase64 = (bytes: Uint8Array): string => {
  if (typeof btoa === "function") {
    let binary = "";
    for (let index = 0; index < bytes.length; index += 1) {
      binary += String.fromCharCode(bytes[index] ?? 0);
    }
    return btoa(binary);
  }

  return Buffer.from(bytes).toString("base64");
};

const buildChimeDataUri = (): string => {
  const totalDurationSeconds = 0.72;
  const sampleCount = Math.floor(CHIME_SAMPLE_RATE * totalDurationSeconds);
  const bytesPerSample = 2;
  const pcmBytes = new Uint8Array(sampleCount * bytesPerSample);
  const fadeSeconds = 0.02;

  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    const currentTimeSeconds = sampleIndex / CHIME_SAMPLE_RATE;
    let sampleValue = 0;

    for (const note of CHIME_NOTES) {
      const relativeTime = currentTimeSeconds - note.offsetSeconds;
      if (relativeTime < 0 || relativeTime > note.durationSeconds) {
        continue;
      }

      const fadeIn = Math.min(1, relativeTime / fadeSeconds);
      const fadeOut = Math.min(1, (note.durationSeconds - relativeTime) / fadeSeconds);
      const envelope = Math.max(0, Math.min(fadeIn, fadeOut));
      sampleValue += Math.sin(2 * Math.PI * note.frequency * relativeTime) * envelope * 0.22;
    }

    const clamped = Math.max(-1, Math.min(1, sampleValue));
    const int16 = Math.round(clamped * 0x7fff);
    const offset = sampleIndex * bytesPerSample;
    pcmBytes[offset] = int16 & 0xff;
    pcmBytes[offset + 1] = (int16 >> 8) & 0xff;
  }

  const header = new Uint8Array(44);
  const view = new DataView(header.buffer);
  const writeAscii = (start: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      header[start + index] = value.charCodeAt(index);
    }
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + pcmBytes.length, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, CHIME_SAMPLE_RATE, true);
  view.setUint32(28, CHIME_SAMPLE_RATE * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, pcmBytes.length, true);

  const wavBytes = new Uint8Array(header.length + pcmBytes.length);
  wavBytes.set(header, 0);
  wavBytes.set(pcmBytes, header.length);
  return `data:audio/wav;base64,${encodeBase64(wavBytes)}`;
};

const getFallbackAudio = (): HTMLAudioElement | null => {
  if (typeof window === "undefined" || typeof Audio === "undefined") {
    return null;
  }

  if (!fallbackAudio) {
    fallbackAudio = new Audio(buildChimeDataUri());
    fallbackAudio.preload = "auto";
  }

  return fallbackAudio;
};

const getAudioContext = (): AudioContext | null => {
  if (typeof window === "undefined") {
    return null;
  }

  const AudioContextCtor = window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) {
    return null;
  }

  audioContext ??= new AudioContextCtor();
  return audioContext;
};

export const unlockPomodoroSound = async (): Promise<void> => {
  const context = getAudioContext();
  if (context && context.state === "suspended") {
    await context.resume();
  }

  const audio = getFallbackAudio();
  if (audio) {
    try {
      audio.muted = true;
      audio.currentTime = 0;
      await audio.play();
      audio.pause();
      audio.currentTime = 0;
      audio.muted = false;
    } catch {
      audio.muted = false;
    }
  }

  if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "default") {
    try {
      await Notification.requestPermission();
    } catch {
      // Ignore notification permission failures; sound still works when available.
    }
  }
};

export const playPomodoroChime = async (): Promise<boolean> => {
  const context = getAudioContext();
  try {
    if (context) {
    if (context.state === "suspended") {
      await context.resume();
    }

    const startAt = context.currentTime;
      CHIME_NOTES.forEach((note) => {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.type = "sine";
        oscillator.frequency.setValueAtTime(note.frequency, startAt + note.offsetSeconds);
        gain.gain.setValueAtTime(0.0001, startAt + note.offsetSeconds);
        gain.gain.exponentialRampToValueAtTime(0.16, startAt + note.offsetSeconds + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, startAt + note.offsetSeconds + note.durationSeconds);
        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.start(startAt + note.offsetSeconds);
        oscillator.stop(startAt + note.offsetSeconds + note.durationSeconds);
      });

      return true;
    }
  } catch {
    // Fall through to HTML audio fallback below.
  }

  const audio = getFallbackAudio();
  if (!audio) {
    return false;
  }

  try {
    audio.pause();
    audio.muted = false;
    audio.currentTime = 0;
    await audio.play();
    return true;
  } catch {
    return false;
  }
};

export const notifyPomodoroCompletion = (title: string, body: string): boolean => {
  if (typeof window === "undefined" || !("Notification" in window) || Notification.permission !== "granted") {
    return false;
  }

  try {
    const notification = new Notification(title, { body, silent: false });
    window.setTimeout(() => notification.close(), 12000);
    return true;
  } catch {
    return false;
  }
};
