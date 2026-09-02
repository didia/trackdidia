import {
  isPermissionGranted,
  requestPermission,
  sendNotification
} from "@tauri-apps/plugin-notification";
import { t } from "../../i18n";
import { logDebug } from "../debug";
import { isTauriRuntime } from "../storage/factory";

let audioContext: AudioContext | null = null;
let unlockPrimerAudio: HTMLAudioElement | null = null;
let silentWavDataUri: string | null = null;
let audioLifecycleHandlersRegistered = false;

export type PomodoroChimeVariant = "session" | "cycle";

let chimeDataUris: Partial<Record<PomodoroChimeVariant, string>> = {};

type ChimeNote = {
  frequency: number;
  offsetSeconds: number;
  durationSeconds: number;
};

const CHIME_SAMPLE_RATE = 44_100;
const CHIME_DURATION_SECONDS: Record<PomodoroChimeVariant, number> = {
  session: 3,
  cycle: 5.5
};

/** Short ascending chime for a single focus or break end. */
const SESSION_CHIME_NOTES: readonly ChimeNote[] = [
  { frequency: 784, offsetSeconds: 0, durationSeconds: 0.16 },
  { frequency: 988, offsetSeconds: 0.2, durationSeconds: 0.16 },
  { frequency: 1175, offsetSeconds: 0.4, durationSeconds: 0.22 }
];

/** Fuller rising fanfare for completing a 4-focus cycle. */
const CYCLE_CHIME_NOTES: readonly ChimeNote[] = [
  { frequency: 523, offsetSeconds: 0, durationSeconds: 0.18 },
  { frequency: 659, offsetSeconds: 0.2, durationSeconds: 0.18 },
  { frequency: 784, offsetSeconds: 0.4, durationSeconds: 0.18 },
  { frequency: 1047, offsetSeconds: 0.62, durationSeconds: 0.3 }
];

const CHIME_NOTES_BY_VARIANT: Record<PomodoroChimeVariant, readonly ChimeNote[]> = {
  session: SESSION_CHIME_NOTES,
  cycle: CYCLE_CHIME_NOTES
};

const getChimePatternDurationSeconds = (notes: readonly ChimeNote[]): number =>
  Math.max(...notes.map((note) => note.offsetSeconds + note.durationSeconds)) + 0.18;

const getChimeDataUri = (variant: PomodoroChimeVariant): string => {
  chimeDataUris[variant] ??= buildChimeDataUri(variant);
  return chimeDataUris[variant]!;
};

const registerAudioLifecycleHandlers = (): void => {
  if (typeof window === "undefined" || typeof document === "undefined" || audioLifecycleHandlersRegistered) {
    return;
  }
  audioLifecycleHandlersRegistered = true;

  const resumeContextIfSuspended = (): void => {
    const context = audioContext;
    if (context && context.state === "suspended") {
      void context.resume().catch(() => {});
    }
  };

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      resumeContextIfSuspended();
    }
  });
  window.addEventListener("focus", resumeContextIfSuspended);
};

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

const buildWavDataUriFromPcm16Mono = (pcmBytes: Uint8Array, sampleRate: number): string => {
  const bytesPerSample = 2;
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
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, pcmBytes.length, true);

  const wavBytes = new Uint8Array(header.length + pcmBytes.length);
  wavBytes.set(header, 0);
  wavBytes.set(pcmBytes, header.length);
  return `data:audio/wav;base64,${encodeBase64(wavBytes)}`;
};

const getSilentWavDataUri = (): string => {
  silentWavDataUri ??= buildWavDataUriFromPcm16Mono(
    new Uint8Array(Math.floor(CHIME_SAMPLE_RATE * 0.05) * 2),
    CHIME_SAMPLE_RATE
  );
  return silentWavDataUri;
};

const buildChimeDataUri = (variant: PomodoroChimeVariant): string => {
  const notes = CHIME_NOTES_BY_VARIANT[variant];
  const loopDurationSeconds = CHIME_DURATION_SECONDS[variant];
  const patternDurationSeconds = getChimePatternDurationSeconds(notes);
  const sampleCount = Math.floor(CHIME_SAMPLE_RATE * loopDurationSeconds);
  const bytesPerSample = 2;
  const pcmBytes = new Uint8Array(sampleCount * bytesPerSample);
  const fadeSeconds = 0.02;

  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    const currentTimeSeconds = sampleIndex / CHIME_SAMPLE_RATE;
    let sampleValue = 0;

    for (
      let patternOffsetSeconds = 0;
      patternOffsetSeconds < loopDurationSeconds;
      patternOffsetSeconds += patternDurationSeconds
    ) {
      for (const note of notes) {
        const relativeTime = currentTimeSeconds - patternOffsetSeconds - note.offsetSeconds;
        if (relativeTime < 0 || relativeTime > note.durationSeconds) {
          continue;
        }

        const fadeIn = Math.min(1, relativeTime / fadeSeconds);
        const fadeOut = Math.min(1, (note.durationSeconds - relativeTime) / fadeSeconds);
        const envelope = Math.max(0, Math.min(fadeIn, fadeOut));
        sampleValue += Math.sin(2 * Math.PI * note.frequency * relativeTime) * envelope * 0.22;
      }
    }

    const clamped = Math.max(-1, Math.min(1, sampleValue));
    const int16 = Math.round(clamped * 0x7fff);
    const offset = sampleIndex * bytesPerSample;
    pcmBytes[offset] = int16 & 0xff;
    pcmBytes[offset + 1] = (int16 >> 8) & 0xff;
  }

  return buildWavDataUriFromPcm16Mono(pcmBytes, CHIME_SAMPLE_RATE);
};

const getUnlockPrimerAudio = (): HTMLAudioElement | null => {
  if (typeof window === "undefined" || typeof Audio === "undefined") {
    return null;
  }

  if (!unlockPrimerAudio) {
    unlockPrimerAudio = new Audio(getSilentWavDataUri());
    unlockPrimerAudio.preload = "auto";
    unlockPrimerAudio.volume = 0;
  }

  return unlockPrimerAudio;
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
  registerAudioLifecycleHandlers();
  return audioContext;
};

const ensureNotificationPermission = async (): Promise<boolean> => {
  if (isTauriRuntime()) {
    try {
      let granted = await isPermissionGranted();
      if (!granted) {
        granted = (await requestPermission()) === "granted";
      }
      return granted;
    } catch {
      return false;
    }
  }

  if (typeof window === "undefined" || !("Notification" in window)) {
    return false;
  }

  if (Notification.permission === "granted") {
    return true;
  }

  if (Notification.permission !== "default") {
    return false;
  }

  try {
    return (await Notification.requestPermission()) === "granted";
  } catch {
    return false;
  }
};

export const unlockPomodoroSound = async (): Promise<void> => {
  const context = getAudioContext();
  if (context && context.state === "suspended") {
    await context.resume();
  }

  const primer = getUnlockPrimerAudio();
  if (primer) {
    try {
      primer.volume = 0;
      primer.currentTime = 0;
      await primer.play();
      primer.pause();
      primer.currentTime = 0;
    } catch {
      // HTMLAudio unlock is best-effort; Web Audio resume above is the main path.
    }
  }

  try {
    await ensureNotificationPermission();
  } catch {
    // Ignore notification permission failures; sound still works when available.
  }
};

const playChimeViaHtmlAudio = async (variant: PomodoroChimeVariant): Promise<boolean> => {
  if (typeof window === "undefined" || typeof Audio === "undefined") {
    return false;
  }

  try {
    const audio = new Audio(getChimeDataUri(variant));
    audio.preload = "auto";
    if ("playsInline" in audio) {
      (audio as HTMLAudioElement & { playsInline?: boolean }).playsInline = true;
    }
    await audio.play();
    return true;
  } catch {
    return false;
  }
};

const scheduleChimeNotes = (
  context: AudioContext,
  notes: readonly ChimeNote[],
  loopDurationSeconds: number
): void => {
  const startAt = context.currentTime;
  const endAt = startAt + loopDurationSeconds;
  const patternDurationSeconds = getChimePatternDurationSeconds(notes);

  for (
    let patternOffsetSeconds = 0;
    patternOffsetSeconds < loopDurationSeconds;
    patternOffsetSeconds += patternDurationSeconds
  ) {
    notes.forEach((note) => {
      const noteStart = startAt + patternOffsetSeconds + note.offsetSeconds;
      const noteEnd = noteStart + note.durationSeconds;
      if (noteStart >= endAt) {
        return;
      }

      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const effectiveEnd = Math.min(noteEnd, endAt);
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(note.frequency, noteStart);
      gain.gain.setValueAtTime(0.0001, noteStart);
      gain.gain.exponentialRampToValueAtTime(0.16, noteStart + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, effectiveEnd);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(noteStart);
      oscillator.stop(effectiveEnd);
    });
  }
};

export const playPomodoroChime = async (variant: PomodoroChimeVariant = "session"): Promise<boolean> => {
  registerAudioLifecycleHandlers();
  const context = getAudioContext();
  const notes = CHIME_NOTES_BY_VARIANT[variant];
  const loopDurationSeconds = CHIME_DURATION_SECONDS[variant];

  try {
    if (context && context.state !== "closed") {
      if (context.state !== "running") {
        await context.resume();
      }

      if (context.state === "running") {
        scheduleChimeNotes(context, notes, loopDurationSeconds);
        return true;
      }
    }
  } catch (error) {
    logDebug("error", "pomodoro.sound", "Web Audio chime failed, fallback to HTML audio", error);
  }

  return playChimeViaHtmlAudio(variant);
};

export const resolvePomodoroChimeVariant = (
  kind: "focus" | "short_break" | "long_break",
  cycleIndex: number
): PomodoroChimeVariant => (kind === "focus" && cycleIndex >= 4 ? "cycle" : "session");

export const notifyPomodoroCompletion = async (title: string, body: string): Promise<boolean> => {
  const granted = await ensureNotificationPermission();
  if (!granted) {
    return false;
  }

  if (isTauriRuntime()) {
    try {
      sendNotification({ title, body, sound: "Ping" });
      return true;
    } catch {
      return false;
    }
  }

  if (typeof window === "undefined" || !("Notification" in window)) {
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

export interface PomodoroCompletionTestResult {
  played: boolean;
  notified: boolean;
  variant: PomodoroChimeVariant;
}

export const testPomodoroChime = async (variant: PomodoroChimeVariant = "session"): Promise<boolean> => {
  await unlockPomodoroSound();
  return playPomodoroChime(variant);
};

export const testPomodoroNotification = async (): Promise<boolean> =>
  notifyPomodoroCompletion(t("pomodoroTestTitle", { ns: "notifications" }), t("pomodoroTestBody", { ns: "notifications" }));

export const testPomodoroCompletionAnnouncement = async (
  variant: PomodoroChimeVariant = "session"
): Promise<PomodoroCompletionTestResult> => {
  const played = await testPomodoroChime(variant);
  const notified = await notifyPomodoroCompletion(
    t("pomodoroTestTitle", { ns: "notifications" }),
    t("pomodoroTestBody", { ns: "notifications" })
  );
  return { played, notified, variant };
};
