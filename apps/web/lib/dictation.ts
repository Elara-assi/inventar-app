/**
 * Slot-Parser fuer die Diktat-Felderkennung (D2) – laeuft offline auf dem
 * Geraet. Identisch implementiert in Python (apps/api/app/dictation.py);
 * gemeinsame Testfaelle: apps/api/tests/dictation_cases.json.
 *
 * Konvention (Spickzettel im Wizard): "Marke ... Typ ... Baujahr ...
 * Seriennummer ... Zustand ...". Reihenfolge egal, Schluesselwoerter zaehlen.
 */

export type DictationResult = {
  object_type?: string;
  object_class_slug?: string;
  brand?: string;
  model?: string;
  serial_number?: string;
  manufacturing_year?: number;
  condition?: string;
  note?: string;
};

const KEYWORDS: Record<string, string> = {
  marke: "brand", hersteller: "brand",
  typ: "model", modell: "model", type: "model", model: "model",
  baujahr: "year",
  seriennummer: "serial", seriennr: "serial",
  zustand: "condition",
  bezeichnung: "object_type",
  hinweis: "note", notiz: "note", bemerkung: "note",
};

const CLASS_SYNONYMS: Record<string, string[]> = {
  hebebuehne: ["hebebuehne", "buehne", "hebelift", "lift"],
  monitor: ["monitor", "bildschirm", "display"],
  reifen: ["reifen", "reifensatz", "komplettraeder"],
  werkzeugwagen: ["werkzeugwagen"],
  it_geraet: ["laptop", "notebook", "computer", "rechner", "pc"],
};

const CONDITION_MAP: Record<string, string> = {
  "neu": "neu", "neuwertig": "neu",
  "sehr gut": "sehr_gut", "sehr guter": "sehr_gut",
  "gut": "gut", "guter": "gut",
  "gebraucht": "gebraucht", "ok": "gebraucht", "okay": "gebraucht",
  "reparaturbeduerftig": "reparaturbeduerftig", "reparatur noetig": "reparaturbeduerftig",
  "reparatur": "reparaturbeduerftig",
  "defekt": "defekt", "kaputt": "defekt",
  "aussondern": "aussondern", "schrott": "aussondern", "entsorgen": "aussondern",
};

const SPELLING: Record<string, string> = {
  anton: "A", berta: "B", caesar: "C", dora: "D", emil: "E", friedrich: "F",
  gustav: "G", heinrich: "H", ida: "I", julius: "J", kaufmann: "K",
  ludwig: "L", martha: "M", nordpol: "N", otto: "O", paula: "P", quelle: "Q",
  richard: "R", samuel: "S", siegfried: "S", theodor: "T", ulrich: "U",
  viktor: "V", wilhelm: "W", xanthippe: "X", ypsilon: "Y", zacharias: "Z",
};

const ONES: Record<string, number> = {
  null: 0, eins: 1, ein: 1, zwei: 2, drei: 3, vier: 4,
  fuenf: 5, sechs: 6, sieben: 7, acht: 8, neun: 9,
};
const TEENS: Record<string, number> = {
  zehn: 10, elf: 11, zwoelf: 12, dreizehn: 13, vierzehn: 14,
  fuenfzehn: 15, sechzehn: 16, siebzehn: 17, achtzehn: 18, neunzehn: 19,
};
const TENS: Record<string, number> = {
  zwanzig: 20, dreissig: 30, vierzig: 40, fuenfzig: 50,
  sechzig: 60, siebzig: 70, achtzig: 80, neunzig: 90,
};

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replaceAll("ä", "ae")
    .replaceAll("ö", "oe")
    .replaceAll("ü", "ue")
    .replaceAll("ß", "ss");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function germanNumber(word: string): number | null {
  const w = normalize(word.trim());
  if (w in ONES) return ONES[w];
  if (w in TEENS) return TEENS[w];
  if (w in TENS) return TENS[w];
  if (w.includes("und")) {
    const idx = w.indexOf("und");
    const head = w.slice(0, idx);
    const tail = w.slice(idx + 3);
    if (head in ONES && tail in TENS) return ONES[head] + TENS[tail];
  }
  return null;
}

export function parseYear(value: string): number | null {
  const v = normalize(value.trim());
  const four = v.match(/\b(19|20)\d{2}\b/);
  if (four) return parseInt(four[0], 10);
  const two = v.match(/\b(\d{1,2})\b/);
  if (two) {
    const n = parseInt(two[1], 10);
    const current = new Date().getFullYear() % 100;
    return n <= current ? 2000 + n : 1900 + n;
  }
  if (v.startsWith("zweitausend")) {
    const rest = v.slice("zweitausend".length).replace(/^und/, "");
    if (!rest) return 2000;
    const n = germanNumber(rest);
    if (n !== null) return 2000 + n;
  }
  const n = germanNumber(v);
  if (n !== null && n <= new Date().getFullYear() % 100) return 2000 + n;
  return null;
}

export function parseSerial(value: string): string | null {
  const tokens = value.replaceAll(",", " ").split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;
  const mapped = tokens.map((token) => {
    const norm = normalize(token);
    if (norm in SPELLING) return SPELLING[norm];
    if (norm in ONES) return String(ONES[norm]);
    if (norm in TEENS) return String(TEENS[norm]);
    return token;
  });
  if (mapped.length === 1) return mapped[0].toUpperCase();
  return mapped.map((part) => part.toUpperCase()).join("");
}

function findKeywordSpans(normalized: string): Array<[number, number, string]> {
  const spans: Array<[number, number, string]> = [];
  for (const [keyword, slot] of Object.entries(KEYWORDS)) {
    const re = new RegExp(`\\b${escapeRegExp(keyword)}\\b`, "g");
    let match: RegExpExecArray | null;
    while ((match = re.exec(normalized)) !== null) {
      spans.push([match.index, match.index + match[0].length, slot]);
    }
  }
  spans.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const result: Array<[number, number, string]> = [];
  let lastEnd = -1;
  for (const span of spans) {
    if (span[0] >= lastEnd) {
      result.push(span);
      lastEnd = span[1];
    }
  }
  return result;
}

const TRIM_CHARS = " ,.;:-";

function trimChars(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && TRIM_CHARS.includes(value[start])) start += 1;
  while (end > start && TRIM_CHARS.includes(value[end - 1])) end -= 1;
  return value.slice(start, end);
}

export function parseDictation(text: string, brands: string[] = []): DictationResult {
  const original = text.trim();
  const normalized = normalize(original);
  const result: DictationResult = {};
  const notes: string[] = [];

  const spans = findKeywordSpans(normalized);
  const headEnd = spans.length ? spans[0][0] : original.length;
  const head = trimChars(original.slice(0, headEnd));

  spans.forEach(([, end, slot], index) => {
    const valueEnd = index + 1 < spans.length ? spans[index + 1][0] : original.length;
    const value = trimChars(original.slice(end, valueEnd));
    if (!value) return;
    if (slot === "brand") {
      result.brand = value.split(",")[0].trim();
    } else if (slot === "model") {
      result.model = value;
    } else if (slot === "year") {
      const year = parseYear(value);
      if (year) result.manufacturing_year = year;
      else notes.push(`Baujahr unklar: ${value}`);
    } else if (slot === "serial") {
      const serial = parseSerial(value);
      if (serial) result.serial_number = serial;
    } else if (slot === "condition") {
      const normValue = normalize(value);
      const phrases = Object.keys(CONDITION_MAP).sort((a, b) => b.length - a.length);
      const hit = phrases.find((phrase) => normValue.startsWith(phrase));
      if (hit) {
        result.condition = CONDITION_MAP[hit];
        const rest = trimChars(value.slice(hit.length));
        if (rest) notes.push(rest);
      } else {
        notes.push(`Zustand unklar: ${value}`);
      }
    } else if (slot === "object_type") {
      result.object_type = value;
    } else if (slot === "note") {
      notes.push(value);
    }
  });

  if (head) {
    const headNorm = normalize(head);
    const headWords = headNorm.split(/\s+/);
    for (const [slug, synonyms] of Object.entries(CLASS_SYNONYMS)) {
      if (headWords.some((word) => synonyms.includes(word))) {
        result.object_class_slug = result.object_class_slug ?? slug;
        break;
      }
    }
    let remaining = head;
    for (const brand of brands) {
      if (new RegExp(`\\b${escapeRegExp(normalize(brand))}\\b`).test(headNorm)) {
        result.brand = result.brand ?? brand;
        remaining = remaining.replace(new RegExp(`\\b${escapeRegExp(brand)}\\b`, "i"), "");
        break;
      }
    }
    remaining = trimChars(remaining);
    if (remaining && !result.object_type) result.object_type = remaining;
  }

  if (!result.brand) {
    for (const brand of brands) {
      if (new RegExp(`\\b${escapeRegExp(normalize(brand))}\\b`).test(normalized)) {
        result.brand = brand;
        break;
      }
    }
  }

  if (notes.length) result.note = notes.join("; ");
  return result;
}
