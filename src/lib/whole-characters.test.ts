import assert from "node:assert/strict";
import { test } from "node:test";

import {
  splitIntoWholeCharacters,
  splitWithoutSegmenter,
  toWellFormedWithoutBuiltIn,
} from "./whole-characters.ts";

const samples = [
  "Robin Casey 😀",
  "élodie",
  "👍🏽 ok",
  "👩🏽‍💻 dev",
  "❤️ love",
  "🏴󠁧󠁢󠁳󠁣󠁴󠁿 flag",
];

// Browsers without Intl.Segmenter (Firefox 115 ESR) take the fallback path,
// which must agree with the segmenter on accents and common emoji.
test("the fallback splits like Intl.Segmenter on accents and emoji", () => {
  for (const sample of samples) {
    assert.deepEqual(
      splitWithoutSegmenter(sample),
      splitIntoWholeCharacters(sample),
      sample,
    );
  }
});

test("the toWellFormed fallback matches the built-in", () => {
  for (const sample of [
    ...samples,
    "\ud83d",
    "a\ud83db",
    "\ude00x",
    "x😀\ud83d",
  ]) {
    assert.equal(toWellFormedWithoutBuiltIn(sample), sample.toWellFormed());
  }
});
