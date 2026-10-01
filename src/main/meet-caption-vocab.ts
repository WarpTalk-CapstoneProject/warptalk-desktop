/**
 * Google Meet's own words, per UI language, for the handful of controls the caption reader needs.
 *
 * One table so a new language is one entry. Only `vi` is backed by a live probe (Chrome 154,
 * fixtures in __tests__/fixtures); `en` is Meet's long-standing English wording; the rest are
 * Meet's published translations as best known and SHOULD be confirmed with a probe before a
 * release claims them. A wrong entry is safe by construction: an unmatched label means "unknown",
 * and unknown never acts.
 *
 * Matching is exact after `normalizeLabel` (case, whitespace, curly quotes, a trailing shortcut
 * hint such as "(c)" or "(ctrl + alt + h)"). Never a substring: "Mở phần cài đặt phụ đề" (caption
 * SETTINGS) contains "phụ đề", and Tactiq's "Toggle captions visibility" contains "captions".
 */

export interface MeetLocaleVocab {
  /** Label of the CC button while captions are OFF ("Turn on captions"). */
  turnOnCaptions: string[];
  /** Label of the CC button while captions are ON ("Turn off captions"). */
  turnOffCaptions: string[];
  /** Accessible name of the captions region. */
  captionsRegion: string[];
  /** Accessible name of the toolbar group holding mic / camera / CC / leave. */
  callControls: string[];
  /** What Meet writes as the speaker for the local user's own captions. */
  selfSpeaker: string[];
}

export const MEET_VOCAB: Record<string, MeetLocaleVocab> = {
  vi: {
    turnOnCaptions: ["Bật phụ đề"],
    turnOffCaptions: ["Tắt phụ đề"],
    captionsRegion: ["Phụ đề"],
    callControls: ["Kiểm soát cuộc gọi"],
    selfSpeaker: ["Bạn"],
  },
  en: {
    turnOnCaptions: ["Turn on captions"],
    turnOffCaptions: ["Turn off captions"],
    captionsRegion: ["Captions"],
    callControls: ["Call controls"],
    selfSpeaker: ["You"],
  },
  ja: {
    turnOnCaptions: ["字幕をオンにする"],
    turnOffCaptions: ["字幕をオフにする"],
    captionsRegion: ["字幕"],
    callControls: ["通話コントロール"],
    selfSpeaker: ["あなた"],
  },
  ko: {
    turnOnCaptions: ["자막 사용", "자막 사용 설정"],
    turnOffCaptions: ["자막 사용 중지"],
    captionsRegion: ["자막"],
    callControls: ["통화 컨트롤", "통화 제어"],
    selfSpeaker: ["나"],
  },
  "zh-CN": {
    turnOnCaptions: ["开启字幕", "打开字幕"],
    turnOffCaptions: ["关闭字幕"],
    captionsRegion: ["字幕"],
    callControls: ["通话控件"],
    selfSpeaker: ["您", "你"],
  },
  "zh-TW": {
    turnOnCaptions: ["開啟字幕"],
    turnOffCaptions: ["關閉字幕"],
    captionsRegion: ["字幕"],
    callControls: ["通話控制項"],
    selfSpeaker: ["你"],
  },
  fr: {
    turnOnCaptions: ["Activer les sous-titres"],
    turnOffCaptions: ["Désactiver les sous-titres"],
    captionsRegion: ["Sous-titres"],
    callControls: ["Commandes d'appel"],
    selfSpeaker: ["Vous"],
  },
  de: {
    turnOnCaptions: ["Untertitel aktivieren"],
    turnOffCaptions: ["Untertitel deaktivieren"],
    captionsRegion: ["Untertitel"],
    callControls: ["Anrufsteuerung"],
    selfSpeaker: ["Ich", "Sie"],
  },
  es: {
    turnOnCaptions: ["Activar subtítulos"],
    turnOffCaptions: ["Desactivar subtítulos"],
    captionsRegion: ["Subtítulos"],
    callControls: ["Controles de llamada"],
    selfSpeaker: ["Tú"],
  },
  pt: {
    turnOnCaptions: ["Ativar legendas"],
    turnOffCaptions: ["Desativar legendas"],
    captionsRegion: ["Legendas"],
    callControls: ["Controles da chamada", "Controles de chamada"],
    selfSpeaker: ["Você"],
  },
};

/** Lower-cased, NFC, single-spaced, straight quotes, without a trailing "(shortcut)" hint. */
export function normalizeLabel(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .normalize("NFC")
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\s*\([^()]*\)$/, "")
    .trim()
    .toLowerCase();
}

type VocabKey = keyof MeetLocaleVocab;

function indexBy(key: VocabKey): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const [locale, vocab] of Object.entries(MEET_VOCAB)) {
    for (const label of vocab[key]) {
      const normalized = normalizeLabel(label);
      const locales = index.get(normalized) ?? [];
      locales.push(locale);
      index.set(normalized, locales);
    }
  }
  return index;
}

const TURN_ON = indexBy("turnOnCaptions");
const TURN_OFF = indexBy("turnOffCaptions");
const REGION = indexBy("captionsRegion");
const CALL_CONTROLS = indexBy("callControls");
const SELF = indexBy("selfSpeaker");

/**
 * Caption state implied by a CC button label: "Turn on captions" means captions are OFF.
 * Null when the label is not a CC label in any known language.
 */
export function captionStateFromLabel(name: string): { state: "on" | "off"; locales: string[] } | null {
  const normalized = normalizeLabel(name);
  const off = TURN_ON.get(normalized);
  if (off) return { state: "off", locales: off };
  const on = TURN_OFF.get(normalized);
  if (on) return { state: "on", locales: on };
  return null;
}

export function isCaptionsRegionName(name: string): boolean {
  return REGION.has(normalizeLabel(name));
}

export function callControlsLocales(name: string): string[] | null {
  return CALL_CONTROLS.get(normalizeLabel(name)) ?? null;
}

export function isSelfSpeaker(name: string): boolean {
  return SELF.has(normalizeLabel(name));
}
