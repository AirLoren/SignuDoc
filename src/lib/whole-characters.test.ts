import assert from "node:assert/strict";
import { test } from "node:test";

import {
  splitIntoWholeCharacters,
  splitWithoutSegmenter,
  toWellFormedWithoutBuiltIn,
} from "./whole-characters.ts";

const samples = [
  "Robin Casey 😀",
  "e\u{301}lodie",
  "👍🏽 ok",
  "👩🏽‍💻 dev",
  "👨‍👩‍👧‍👦 family",
  "❤️ love",
  "1️⃣ keycap",
  "🏴󠁧󠁢󠁳󠁣󠁴󠁿 flag",
  "🇺🇸",
  "🇺🇸🇫🇷🇩",
  "Kim 김민준",
  "\u{1100}\u{1161}\u{11A8} jamo",
  "\u{AC00}\u{11A8}",
  "क्षमा शर्मा",
  "ক্ষ স্ত",
  "ਸਿੰਘ",
  "สมชาย",
  "a\r\nb",
  "\u{200D}a",
  "😀\u{200D}",
  "a\u{200D}😀",
];

// Browsers without Intl.Segmenter (Firefox 115 ESR) take the fallback path.
// The server always has the segmenter, so the two must agree, or an avatar
// rendered on the server won't hydrate.
test("the fallback splits like Intl.Segmenter", () => {
  for (const sample of samples) {
    assert.deepEqual(
      splitWithoutSegmenter(sample),
      splitIntoWholeCharacters(sample),
      JSON.stringify(sample),
    );
  }
});

test("the fallback agrees on every Indic consonant-virama-consonant", () => {
  for (const virama of [0x94d, 0x9cd, 0xacd, 0xb4d, 0xc4d, 0xd4d]) {
    const ka = String.fromCodePoint(virama - 0x4d + 0x15);

    for (let code = virama - 0x4d; code < virama - 0x4d + 0x80; code += 1) {
      const sample = `${ka}${String.fromCodePoint(virama)}${String.fromCodePoint(code)}`;

      assert.deepEqual(
        splitWithoutSegmenter(sample),
        splitIntoWholeCharacters(sample),
        JSON.stringify(sample),
      );
    }
  }
});

test("the fallback agrees on every Hangul jamo pair", () => {
  const jamo = [
    0x1100, 0x115f, 0x1160, 0x11a7, 0x11a8, 0x11ff, 0xa960, 0xd7b0, 0xd7cb,
    0xac00, 0xac01,
  ];

  for (const first of jamo) {
    for (const second of jamo) {
      const sample = String.fromCodePoint(first, second);

      assert.deepEqual(
        splitWithoutSegmenter(sample),
        splitIntoWholeCharacters(sample),
        JSON.stringify(sample),
      );
    }
  }
});

test("the toWellFormed fallback matches the built-in", () => {
  for (const sample of [
    ...samples,
    "\u{FFFD}",
    String.fromCharCode(0xd83d),
    `a${String.fromCharCode(0xd83d)}b`,
    `${String.fromCharCode(0xde00)}x`,
    `x😀${String.fromCharCode(0xd83d)}`,
  ]) {
    assert.equal(toWellFormedWithoutBuiltIn(sample), sample.toWellFormed());
  }
});
