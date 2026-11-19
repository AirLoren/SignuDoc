const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

const startsWithLetterOrDigit = /^[\p{L}\p{N}]/u;

function wholeCharacters(word: string): string[] {
  return Array.from(graphemeSegmenter.segment(word), ({ segment }) => segment);
}

type InitialsOptions = {
  // Most initials to return.
  max: number;
  // For a one-word name, how many of its characters to use ("Robin" -> "RO").
  singleWordLength?: number;
};

// Builds the initials shown in a person's avatar from their name, one whole
// character per word. Taking part[0] of a word reads one UTF-16 code unit,
// which is half of an emoji: the server then renders U+FFFD while the browser
// keeps the lone surrogate, and React reports a hydration mismatch. Words that
// do not start with a letter or digit (an emoji, a dash) are skipped, unless
// the name has nothing else.
export function getInitials(name: string, options: InitialsOptions): string {
  const words = name.toWellFormed().trim().split(/\s+/).filter(Boolean);

  if (words.length === 0) {
    return "";
  }

  const namedWords = words.filter((word) => startsWithLetterOrDigit.test(word));
  const sourceWords = namedWords.length > 0 ? namedWords : words.slice(0, 1);

  if (sourceWords.length === 1 && options.singleWordLength) {
    return wholeCharacters(sourceWords[0]!)
      .slice(0, Math.min(options.singleWordLength, options.max))
      .join("")
      .toUpperCase();
  }

  return sourceWords
    .slice(0, options.max)
    .map((word) => wholeCharacters(word)[0] ?? "")
    .join("")
    .toUpperCase();
}
