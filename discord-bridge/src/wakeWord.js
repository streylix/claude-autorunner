'use strict';

// Wake-word gating. Only speech that begins with the wake phrase is forwarded to
// the manager; everything else is ignored.
//
// Matching is PHONETIC (Soundex), not literal, because Whisper renders short
// names inconsistently — e.g. "sean" comes back as "Shawn", "Shaun", "Seen",
// "Schon", etc. Soundex collapses all of those to the same code (S500), so the
// wake word triggers regardless of spelling, while still rejecting unrelated
// words ("John" → J500, "Larry" → L600). We also keep an exact/contains fast
// path and a small edit-distance tolerance.
//
// IMPLEMENTATION NOTE — why text-based gating (not native Vosk): see SETUP.md.
// The app uses Vosk in the renderer; there's no working native Vosk for Node, so
// the bridge transcribes each utterance with the app's local Whisper and gates
// on the text. The phrase itself is mirrored live from the app's settings.

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Classic Soundex: letter + 3 digits. Good enough to collapse homophones of a
// short wake word while keeping unrelated words distinct.
function soundex(word) {
  const s = String(word || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (!s) return '';
  const code = { B: 1, F: 1, P: 1, V: 1, C: 2, G: 2, J: 2, K: 2, Q: 2, S: 2, X: 2, Z: 2, D: 3, T: 3, L: 4, M: 5, N: 5, R: 6 };
  let out = s[0];
  let prev = code[s[0]] || 0;
  for (let i = 1; i < s.length && out.length < 4; i++) {
    const c = s[i];
    const d = code[c] || 0;
    if (d && d !== prev) out += d;
    // H and W don't reset the "previous code" (so e.g. "shawn" stays S500);
    // vowels do.
    if (c !== 'H' && c !== 'W') prev = d;
  }
  return (out + '000').slice(0, 4);
}

// Levenshtein (small words only) for an extra bit of tolerance.
function lev(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[m][n];
}

const SCAN_WINDOW = 4; // how many leading words to scan for the wake word

// Curated WEAK homophones for hard single-word wake NAMES the speech engines
// keep mangling. These are COMMON English words, so they only count when they
// (a) LEAD the utterance, (b) appear in a SHORT utterance, and (c) are confirmed
// by Whisper (see voiceReceive._detectWake) — never on a bare low-confidence
// guess. That combination matches a lone "sean" heard as "don"/"on"/"dawn"
// without firing on mid-sentence "turn it on" / "I'm done".
//
// "sean" is /ʃɔːn/ (SHAWN): {sh/s/j/d/g/r/v/w/h/y/f/l/p}-onset + the -awn/-on/-un
// rime. The strong soundex path already covers the S500 spellings
// (sean/shawn/shaun/shon/seen), so this set is the OTHER-onset homophones that
// soundex scatters into different buckets. Observed live: don john jon on dawn
// done dumb. Ordered roughly by how close they sound (for future weighting).
const WEAK_WAKE_VARIANTS = {
  sean: [
    'don', 'dawn', 'done', 'john', 'jon', 'on', 'dumb', 'dawne', 'dom', 'gone',
    'drawn', 'vaughn', 'ron', 'han', 'wan', 'yawn', 'fawn', 'lawn', 'pawn',
    'sawn', 'shon', 'schon', 'sron', 'sean stone',
  ],
};

// Max tokens for the weak (common-word) homophone path to apply — short enough
// to look like a wake attempt, not normal speech. Default 2 (a lone wake, or
// wake + one short word) keeps very common words like "on" from triggering on
// 3-word fragments such as "on the server". Env-overridable for tuning.
const WEAK_MAX_TOKENS = Number(process.env.WAKE_WEAK_MAX_TOKENS) || 2;

class WakeSpotter {
  constructor(phrase = 'hey claude') {
    this.setPhrase(phrase);
  }

  setPhrase(phrase) {
    const norm = normalize(phrase) || 'hey claude';
    if (norm === this._phraseRaw) return;
    this._phraseRaw = norm;
    this.phrase = norm;
    this.phraseWords = norm.split(' ');
    this.phraseCodes = this.phraseWords.map(soundex);
    // Weak single-token homophones only apply to a single-word wake phrase.
    // Each entry may itself be multi-token ("sean stone") — keep the leading
    // token, which is what we match against the utterance's first word.
    const variants = WEAK_WAKE_VARIANTS[norm] || [];
    this.weakVariants = new Set(variants.map((v) => v.split(' ')[0]));
    this.weakMaxTokens = WEAK_MAX_TOKENS;
  }

  // Does a single transcript word match a single phrase word?
  _wordMatches(word, phraseWord, phraseCode) {
    if (!word) return false;
    if (word === phraseWord) return true;
    if (soundex(word) === phraseCode) return true;
    const maxLen = Math.max(word.length, phraseWord.length);
    return maxLen <= 5 ? lev(word, phraseWord) <= 1 : lev(word, phraseWord) <= 2;
  }

  // Strip ALL leading wake-word occurrences and return the remaining command.
  // "sean sean sean" -> "", "sean what's up" -> "what's up",
  // "hey claude hey claude do it" -> "do it". Returns '' if only wake words.
  stripWake(text) {
    const origWords = String(text || '').trim().split(/\s+/).filter(Boolean);
    const normWords = normalize(text).split(' ').filter(Boolean);
    const n = this.phraseWords.length;
    let i = 0;
    if (n === 1) {
      while (i < normWords.length && this._wordMatches(normWords[i], this.phraseWords[0], this.phraseCodes[0])) i++;
    } else {
      outer: while (i + n <= normWords.length) {
        for (let k = 0; k < n; k++) {
          if (!this._wordMatches(normWords[i + k], this.phraseWords[k], this.phraseCodes[k])) break outer;
        }
        i += n;
      }
    }
    return origWords.slice(i).join(' ').trim();
  }

  // Is the whole utterance nothing but (repeated) wake words?
  isOnlyWake(text) {
    return this.check(text).detected && this.stripWake(text) === '';
  }

  // Returns { detected, command, via } where via ∈ 'strong' | 'weak'.
  //   strong — exact / soundex / small-edit-distance match (high confidence).
  //   weak   — a curated common-word homophone, gated to utterance-initial in a
  //            SHORT utterance (callers should additionally Whisper-confirm it).
  check(text) {
    const norm = normalize(text);
    if (!norm) return { detected: false, command: '' };
    const words = norm.split(' ');
    const n = this.phraseWords.length;
    const origWords = String(text).trim().split(/\s+/);

    // 1) STRONG: scan the first few word positions for the (fuzzy) phrase.
    for (let i = 0; i <= Math.min(SCAN_WINDOW, words.length - n); i++) {
      let all = true;
      for (let k = 0; k < n; k++) {
        if (!this._wordMatches(words[i + k], this.phraseWords[k], this.phraseCodes[k])) { all = false; break; }
      }
      if (all) {
        const command = origWords.slice(i + n).join(' ').trim();
        return { detected: true, command, via: 'strong' };
      }
    }

    // 2) WEAK: a single-word wake phrase misheard as a curated homophone — only
    // when it LEADS a SHORT utterance (looks like a wake attempt, not normal
    // speech). Catches a lone "sean" rendered "don"/"on"/"dawn"/etc.
    if (n === 1 && this.weakVariants.size &&
        words.length <= this.weakMaxTokens && this.weakVariants.has(words[0])) {
      const command = origWords.slice(1).join(' ').trim();
      return { detected: true, command, via: 'weak' };
    }

    return { detected: false, command: '' };
  }
}

module.exports = { WakeSpotter, normalize, soundex };
