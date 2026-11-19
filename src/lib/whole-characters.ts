// Helpers for cutting text only between whole characters. They run in the
// browser too, so they don't rely on Intl.Segmenter (Firefox 125+) or
// String.prototype.toWellFormed (Firefox 119+) being present: Firefox 115 ESR
// has neither.

const graphemeSegmenter =
  typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

const replacementCharacter = String.fromCharCode(0xfffd);

// Swaps each lone surrogate for U+FFFD, like toWellFormed().
export function toWellFormedText(value: string): string {
  if (typeof value.toWellFormed === "function") {
    return value.toWellFormed();
  }

  return toWellFormedWithoutBuiltIn(value);
}

// Exported for tests. Iterating a string by code point yields a lone
// surrogate as a one-unit string, which is how it is found here (no regex
// lookbehind, which Safari before 16.4 can't parse).
export function toWellFormedWithoutBuiltIn(value: string): string {
  let result = "";

  for (const codePoint of value) {
    const unit = codePoint.charCodeAt(0);
    const isLone = codePoint.length === 1 && unit >= 0xd800 && unit <= 0xdfff;

    result += isLone ? replacementCharacter : codePoint;
  }

  return result;
}

// Code points that belong to the character before them: combining marks,
// variation selectors, emoji skin tones, tag characters and the zero-width
// joiner, plus the code point a joiner glues on.
const extendsCharacter = /^[\p{M}‍︀-️\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}]$/u;

// Splits text into whole characters (grapheme clusters). Without
// Intl.Segmenter it keeps marks, joiners and modifiers with their base
// character, which covers accents and most emoji.
export function splitIntoWholeCharacters(value: string): string[] {
  const text = toWellFormedText(value);

  if (graphemeSegmenter) {
    return Array.from(
      graphemeSegmenter.segment(text),
      ({ segment }) => segment,
    );
  }

  return splitWithoutSegmenter(text);
}

// Exported for tests: the path browsers without Intl.Segmenter take.
export function splitWithoutSegmenter(text: string): string[] {
  const characters: string[] = [];
  let joinNext = false;

  for (const codePoint of text) {
    if (
      characters.length > 0 &&
      (joinNext || extendsCharacter.test(codePoint))
    ) {
      characters[characters.length - 1] += codePoint;
    } else {
      characters.push(codePoint);
    }

    joinNext = codePoint === "‍";
  }

  return characters;
}
