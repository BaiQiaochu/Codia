export interface VoiceSettings {
  recognitionLang: string;
  recognitionInputDeviceId: string;
  synthesisVoiceUri: string;
  synthesisRate: number;
  synthesisPitch: number;
  synthesisVolume: number;
}

export interface AudioInputDevice {
  deviceId: string;
  label: string;
  groupId?: string;
}

export interface SpeechRecognitionAlternativeLike {
  transcript?: string;
}

export interface SpeechRecognitionResultLike {
  isFinal?: boolean;
  [index: number]: SpeechRecognitionAlternativeLike | undefined;
}

export interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResultLike>;
}

export interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onstart: (() => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

export interface SpeechRecognitionCtorLike {
  new (): SpeechRecognitionLike;
}

const STORAGE_KEY = 'codia-voice-settings';

const DEFAULT_SETTINGS: VoiceSettings = {
  recognitionLang: 'zh-CN',
  recognitionInputDeviceId: '',
  synthesisVoiceUri: '',
  synthesisRate: 1,
  synthesisPitch: 1,
  synthesisVolume: 1,
};

export function getVoiceRecognitionCtor(): SpeechRecognitionCtorLike | null {
  if (typeof window === 'undefined') return null;
  return (
    (window as Window & {
      SpeechRecognition?: SpeechRecognitionCtorLike;
      webkitSpeechRecognition?: SpeechRecognitionCtorLike;
    }).SpeechRecognition ||
    (window as Window & {
      SpeechRecognition?: SpeechRecognitionCtorLike;
      webkitSpeechRecognition?: SpeechRecognitionCtorLike;
    }).webkitSpeechRecognition ||
    null
  );
}

export function supportsVoiceRecognition(): boolean {
  return !!getVoiceRecognitionCtor();
}

export function supportsVoiceSynthesis(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

export function supportsAudioInputDevices(): boolean {
  return typeof navigator !== 'undefined'
    && !!navigator.mediaDevices?.enumerateDevices
    && !!navigator.mediaDevices?.getUserMedia;
}

export async function listAudioInputDevices(): Promise<AudioInputDevice[]> {
  if (!supportsAudioInputDevices()) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  let index = 0;
  return devices
    .filter(device => device.kind === 'audioinput')
    .map(device => {
      index += 1;
      return {
        deviceId: device.deviceId,
        label: device.label || `Microphone ${index}`,
        groupId: device.groupId || undefined,
      };
    });
}

export async function requestAudioInputPermission(deviceId = ''): Promise<void> {
  if (!supportsAudioInputDevices()) {
    throw new Error('audio input devices are not supported');
  }
  const audio = deviceId
    ? { deviceId: { exact: deviceId } }
    : true;
  const stream = await navigator.mediaDevices.getUserMedia({ audio });
  for (const track of stream.getTracks()) {
    track.stop();
  }
}

export function getVoiceSettings(): VoiceSettings {
  if (typeof window === 'undefined') return { ...DEFAULT_SETTINGS };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return {
        ...DEFAULT_SETTINGS,
        recognitionLang: window.i18n?.locale || DEFAULT_SETTINGS.recognitionLang,
      };
    }
    const parsed = JSON.parse(raw) as Partial<VoiceSettings>;
    return {
      ...DEFAULT_SETTINGS,
      recognitionLang: window.i18n?.locale || DEFAULT_SETTINGS.recognitionLang,
      ...parsed,
    };
  } catch {
    return {
      ...DEFAULT_SETTINGS,
      recognitionLang: window.i18n?.locale || DEFAULT_SETTINGS.recognitionLang,
    };
  }
}

export function saveVoiceSettings(partial: Partial<VoiceSettings>): VoiceSettings {
  const next = { ...getVoiceSettings(), ...partial };
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  }
  return next;
}
