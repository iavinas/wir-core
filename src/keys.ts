// Key names, virtual key codes, and chord dispatch — the mechanics behind
// `act key`.
//
// ─── THIRD-PARTY CODE ────────────────────────────────────────────────────────

// MIT licensed, Copyright (c) 2024 Gregor Zunic:
//   browser_use/actor/utils.py  Utils.get_key_info()  ->  KEY_MAP + keyInfo()
//   browser_use/actor/page.py   Page.press()          ->  MODIFIER_BITS,
//                                                         parseChord, pressChord
// The full MIT text and a statement of exactly what was taken are in NOTICE at
// the repository root, which ships in the published tarball (package.json
// `files`). @wir/core itself is Apache-2.0; MIT-into-Apache-2.0 is permitted so
// long as that notice travels with every copy.
// ─────────────────────────────────────────────────────────────────────────────
//
// One behaviour is deliberately NOT ported. Upstream's last line returns
// `(key, None)` for anything it does not recognise, so `press('flurb')`
// dispatches keyDown/keyUp with code 'flurb' and no virtual key code — an event
// no browser acts on, reported as a successful press. That silent no-op is the

// value="Control+a"` returned `verified/text_typed` while destroying the file),
// so an unrecognised name returns null here and `act` refuses the press.
//
// Everything else is upstream's: the table's contents, the letter/digit rules,
// the bitmask values, and the press-modifiers / dispatch-main / release-in-
// reverse ordering.

/** Key name -> [DOM `code`, Windows virtual-key code]. 114 entries. */
export const KEY_MAP: Readonly<Record<string, readonly [string, number]>> = {
  // Navigation keys
  Backspace: ['Backspace', 8],
  Tab: ['Tab', 9],
  Enter: ['Enter', 13],
  Escape: ['Escape', 27],
  Space: ['Space', 32],
  ' ': ['Space', 32],
  PageUp: ['PageUp', 33],
  PageDown: ['PageDown', 34],
  End: ['End', 35],
  Home: ['Home', 36],
  ArrowLeft: ['ArrowLeft', 37],
  ArrowUp: ['ArrowUp', 38],
  ArrowRight: ['ArrowRight', 39],
  ArrowDown: ['ArrowDown', 40],
  Insert: ['Insert', 45],
  Delete: ['Delete', 46],
  // Modifier keys
  Shift: ['ShiftLeft', 16],
  ShiftLeft: ['ShiftLeft', 16],
  ShiftRight: ['ShiftRight', 16],
  Control: ['ControlLeft', 17],
  ControlLeft: ['ControlLeft', 17],
  ControlRight: ['ControlRight', 17],
  Alt: ['AltLeft', 18],
  AltLeft: ['AltLeft', 18],
  AltRight: ['AltRight', 18],
  Meta: ['MetaLeft', 91],
  MetaLeft: ['MetaLeft', 91],
  MetaRight: ['MetaRight', 92],
  // Function keys F1-F24
  F1: ['F1', 112],
  F2: ['F2', 113],
  F3: ['F3', 114],
  F4: ['F4', 115],
  F5: ['F5', 116],
  F6: ['F6', 117],
  F7: ['F7', 118],
  F8: ['F8', 119],
  F9: ['F9', 120],
  F10: ['F10', 121],
  F11: ['F11', 122],
  F12: ['F12', 123],
  F13: ['F13', 124],
  F14: ['F14', 125],
  F15: ['F15', 126],
  F16: ['F16', 127],
  F17: ['F17', 128],
  F18: ['F18', 129],
  F19: ['F19', 130],
  F20: ['F20', 131],
  F21: ['F21', 132],
  F22: ['F22', 133],
  F23: ['F23', 134],
  F24: ['F24', 135],
  // Numpad keys
  NumLock: ['NumLock', 144],
  Numpad0: ['Numpad0', 96],
  Numpad1: ['Numpad1', 97],
  Numpad2: ['Numpad2', 98],
  Numpad3: ['Numpad3', 99],
  Numpad4: ['Numpad4', 100],
  Numpad5: ['Numpad5', 101],
  Numpad6: ['Numpad6', 102],
  Numpad7: ['Numpad7', 103],
  Numpad8: ['Numpad8', 104],
  Numpad9: ['Numpad9', 105],
  NumpadMultiply: ['NumpadMultiply', 106],
  NumpadAdd: ['NumpadAdd', 107],
  NumpadSubtract: ['NumpadSubtract', 109],
  NumpadDecimal: ['NumpadDecimal', 110],
  NumpadDivide: ['NumpadDivide', 111],
  // Lock keys
  CapsLock: ['CapsLock', 20],
  ScrollLock: ['ScrollLock', 145],
  // OEM/Punctuation keys (US keyboard layout)
  Semicolon: ['Semicolon', 186],
  ';': ['Semicolon', 186],
  Equal: ['Equal', 187],
  '=': ['Equal', 187],
  Comma: ['Comma', 188],
  ',': ['Comma', 188],
  Minus: ['Minus', 189],
  '-': ['Minus', 189],
  Period: ['Period', 190],
  '.': ['Period', 190],
  Slash: ['Slash', 191],
  '/': ['Slash', 191],
  Backquote: ['Backquote', 192],
  '`': ['Backquote', 192],
  BracketLeft: ['BracketLeft', 219],
  '[': ['BracketLeft', 219],
  Backslash: ['Backslash', 220],
  '\\': ['Backslash', 220],
  BracketRight: ['BracketRight', 221],
  ']': ['BracketRight', 221],
  Quote: ['Quote', 222],
  "'": ['Quote', 222],
  // Media/Browser keys
  AudioVolumeMute: ['AudioVolumeMute', 173],
  AudioVolumeDown: ['AudioVolumeDown', 174],
  AudioVolumeUp: ['AudioVolumeUp', 175],
  MediaTrackNext: ['MediaTrackNext', 176],
  MediaTrackPrevious: ['MediaTrackPrevious', 177],
  MediaStop: ['MediaStop', 178],
  MediaPlayPause: ['MediaPlayPause', 179],
  BrowserBack: ['BrowserBack', 166],
  BrowserForward: ['BrowserForward', 167],
  BrowserRefresh: ['BrowserRefresh', 168],
  BrowserStop: ['BrowserStop', 169],
  BrowserSearch: ['BrowserSearch', 170],
  BrowserFavorites: ['BrowserFavorites', 171],
  BrowserHome: ['BrowserHome', 172],
  // Additional common keys
  Clear: ['Clear', 12],
  Pause: ['Pause', 19],
  Select: ['Select', 41],
  Print: ['Print', 42],
  Execute: ['Execute', 43],
  PrintScreen: ['PrintScreen', 44],
  Help: ['Help', 47],
  ContextMenu: ['ContextMenu', 93],
};

/** Modifier bit values used by key chords. */
export const MODIFIER_BITS: Readonly<Record<string, number>> = {
  Alt: 1,
  Control: 2,
  Meta: 4,
  Shift: 8,
};

export interface KeyInfo {
  code: string;
  vk: number | null;
}

/** The `code` and Windows virtual-key code for a key name, or null when the
 *  name is not one this runtime can press (upstream's `(key, None)` fallback —
 *  see the header for why that arm is a refusal here). */
export function keyInfo(key: string): KeyInfo | null {
  // hasOwn, not a bare lookup: the model's tokens reach this string, and a bare
  // `KEY_MAP['toString']` answers with Object.prototype's method — a truthy
  // "entry" whose code is undefined.
  const entry = Object.hasOwn(KEY_MAP, key) ? KEY_MAP[key] : undefined;
  if (entry !== undefined) return { code: entry[0], vk: entry[1] };
  if (key.length === 1) {
    // Letter keys: A-Z have VK codes 65-90. Digit keys: 0-9 have 48-57.
    if (/^[a-zA-Z]$/.test(key)) {
      return { code: `Key${key.toUpperCase()}`, vk: key.toUpperCase().charCodeAt(0) };
    }
    if (/^[0-9]$/.test(key)) return { code: `Digit${key}`, vk: key.charCodeAt(0) };
  }
  return null;
}

export interface Chord {
  modifiers: string[];
  mainKey: string;
  bitmask: number;
}

/** Split a key spec on '+' into modifiers and a main key, upstream's rule.
 *  Returns null when any part is not pressable — an unknown modifier name, an
 *  unknown main key, or an empty segment (`"+"`, `"Control+"`). */
export function parseChord(spec: string): Chord | null {
  // A bare '+' is the key itself, not a separator: the table has no entry for
  // it, so it fails the keyInfo check below like any other unknown name.
  const parts = spec.split('+');
  const mainKey = parts[parts.length - 1] ?? '';
  const modifiers = parts.slice(0, -1);
  if (keyInfo(mainKey) === null) return null;
  let bitmask = 0;
  for (const mod of modifiers) {
    const bit = Object.hasOwn(MODIFIER_BITS, mod) ? MODIFIER_BITS[mod] : undefined;
    if (bit === undefined) return null;
    bitmask |= bit;
  }
  return { modifiers, mainKey, bitmask };
}

/** Does this string look like a key chord rather than text to type? True only
 *  for a WHOLE value of the form Modifier(+Modifier)*+Key — deliberately not
 *  for a bare key name, because "Enter", "Tab", "Delete", "Home", "Clear",
 *  "Select" and "Help" are also ordinary English words a page may legitimately
 *  ask a caller to type. */
export function looksLikeChord(value: string): boolean {
  if (!value.includes('+')) return false;
  const chord = parseChord(value);
  return chord !== null && chord.modifiers.length > 0;
}

export type DispatchKeyEvent = (params: {
  type: 'keyDown' | 'keyUp' | 'rawKeyDown';
  key: string;
  code: string;
  modifiers?: number;
  windowsVirtualKeyCode?: number;
  text?: string;
  unmodifiedText?: string;
}) => Promise<unknown>;

/** The character a key produces, or '' when it produces none.
 *
 *  WHY THIS EXISTS. Chrome emits `keypress` ONLY for a `keyDown` that carries
 *  `text`; a keyDown without it is a `rawKeyDown` and fires keydown/keyup alone.
 *  Until this, pressChord sent neither, so `act key Enter` could never trigger a
 *  `keypress` handler — and submitting a field with Enter is one of the web's
 * This behavior was verified during testing.
 *  request listens for `keypress` on the input, and `act key Enter` on a field
 *  already holding "squash" returned `unknown / no_observable_change_yet` and
 *  scored nothing, because no keypress was ever produced.
 *
 *  The table and the modifier rule are Chromium's own, via Playwright's
 *  usKeyboardLayout.ts:93 ('Enter' -> text '\r') and input.ts:78-80 ("if any
 *  modifiers besides shift are pressed, no text should be sent") — which is why
 *  Control+a still sends nothing and the select-all path is unchanged. */
export function keyText(key: string, modifiers: readonly string[]): string {
  // A non-shift modifier suppresses text entirely: Control+a is a command, not
  // the letter 'a'. Shift is the exception — it SELECTS the character.
  if (modifiers.some((m) => m !== 'Shift' && m !== 'ShiftLeft' && m !== 'ShiftRight')) return '';
  if (Object.hasOwn(TEXT_KEYS, key)) return TEXT_KEYS[key] as string;
  // A single printable character is its own text. Control characters are not:
  // charCodeAt < 0x20 covers the C0 range that has a name in KEY_MAP instead.
  if (key.length === 1 && key.charCodeAt(0) >= 0x20) return key;
  return '';
}

/** Named keys that still produce a character. Everything absent here — the
 *  arrows, Escape, the function keys — produces none, which is why they emit
 *  rawKeyDown and no keypress, exactly as a real keyboard does. */
const TEXT_KEYS: Readonly<Record<string, string>> = {
  Enter: '\r',
  NumpadEnter: '\r',
  Tab: '\t',
  Space: ' ',
  ' ': ' ',
};

/** Press a chord: modifiers down in order, main key down+up carrying the
 *  bitmask, modifiers up in reverse. Upstream's sequence exactly. */
export async function pressChord(dispatch: DispatchKeyEvent, chord: Chord): Promise<void> {
  const withVk = (
    base: {
      type: 'keyDown' | 'keyUp' | 'rawKeyDown';
      key: string;
      code: string;
      modifiers?: number;
    },
    vk: number | null,
  ): Parameters<DispatchKeyEvent>[0] =>
    vk === null ? base : { ...base, windowsVirtualKeyCode: vk };

  for (const mod of chord.modifiers) {
    const info = keyInfo(mod) as KeyInfo; // parseChord proved every part resolves
    await dispatch(withVk({ type: 'keyDown', key: mod, code: info.code }, info.vk));
  }
  const main = keyInfo(chord.mainKey) as KeyInfo;
  // `text` is what makes Chrome emit `keypress`; without it this is a
  // rawKeyDown and a keypress listener never runs. See keyText above.
  const text = keyText(chord.mainKey, chord.modifiers);
  const down = withVk(
    {
      type: text === '' ? 'rawKeyDown' : 'keyDown',
      key: chord.mainKey,
      code: main.code,
      modifiers: chord.bitmask,
    },
    main.vk,
  );
  await dispatch(text === '' ? down : { ...down, text, unmodifiedText: text });
  await dispatch(
    withVk(
      { type: 'keyUp', key: chord.mainKey, code: main.code, modifiers: chord.bitmask },
      main.vk,
    ),
  );
  for (const mod of [...chord.modifiers].reverse()) {
    const info = keyInfo(mod) as KeyInfo;
    await dispatch(withVk({ type: 'keyUp', key: mod, code: info.code }, info.vk));
  }
}
