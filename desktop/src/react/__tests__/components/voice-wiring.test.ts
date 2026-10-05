import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');

function read(relPath: string) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

describe('voice wiring', () => {
  it('InputArea keeps speech recognition button and start/stop flow wired', () => {
    const source = read('components/InputArea.tsx');

    expect(source).toContain("supportsVoiceRecognition()");
    expect(source).toContain("getVoiceRecognitionCtor()");
    expect(source).toContain("recognition.start()");
    expect(source).toContain("recognitionRef.current.stop()");
    expect(source).toContain("settings.media.startRecording");
    expect(source).toContain("settings.media.stopRecording");
  });

  it('InputArea routes selected hardware microphone recording through backend transcription', () => {
    const source = read('components/InputArea.tsx');

    expect(source).toContain("recognitionInputDeviceId");
    expect(source).toContain("navigator.mediaDevices.getUserMedia");
    expect(source).toContain("new MediaRecorder");
    expect(source).toContain("'/api/voice/transcribe'");
    expect(source).toContain("formData.append('agentId'");
    expect(source).toContain("formData.append('sessionPath'");
  });

  it('AssistantMessage keeps speech synthesis speak/cancel flow wired', () => {
    const source = read('components/chat/AssistantMessage.tsx');
    const actionsSource = read('components/chat/MessageActions.tsx');

    expect(source).toContain("window.speechSynthesis.cancel()");
    expect(source).toContain("new SpeechSynthesisUtterance(text)");
    expect(source).toContain("window.speechSynthesis.speak(utterance)");
    expect(source).toContain("onSpeak: (typeof window !== 'undefined' && 'speechSynthesis' in window) ? handleSpeak : undefined");
    expect(actionsSource).toContain("common.readAloud");
    expect(actionsSource).toContain("common.stopReading");
  });
});
