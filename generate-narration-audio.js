// generate-narration-audio.js
//
// Generates MP3s for either:
//   --kind=tafsir      (default) the dramatized narration, from narrations.json
//                      -> narration-audio/<surah>/<verse>.mp3
//   --kind=translation the plain English translation, fetched live from
//                      the same api.alquran.cloud edition the app itself
//                      uses, so the audio always matches what's on screen
//                      -> translation-audio/<edition>/<surah>/<verse>.mp3
//
// Usage:
//   node generate-narration-audio.js                              // tafsir, all 114 surahs
//   node generate-narration-audio.js --kind=translation            // translation, default edition (en.sahih)
//   node generate-narration-audio.js --kind=translation --translation=en.yusufali
//   node generate-narration-audio.js --surah=24                    // just one surah (either kind)
//   node generate-narration-audio.js --surah=24,25,33
//   node generate-narration-audio.js --voice=en-US-Neural2-J
//   node generate-narration-audio.js --concurrency=8
//
// Re-running is safe: any verse whose MP3 already exists is skipped, so
// you can stop and resume freely, or re-run after adding new surahs.
//
// Setup (one-time):
//   1. Create/select a project at https://console.cloud.google.com
//   2. Enable the "Cloud Text-to-Speech API" for that project
//   3. Create a service account with the "Cloud Text-to-Speech User" role
//   4. Create a JSON key for it and download it
//   5. Set the environment variable before running:
//        export GOOGLE_APPLICATION_CREDENTIALS="/path/to/key.json"
//   6. npm install
//   7. npm run generate                              (tafsir)
//      node generate-narration-audio.js --kind=translation   (translation)
//
// Requires Node 18+ (uses the built-in fetch for --kind=translation).

"use strict";

const fs = require("fs");
const path = require("path");
const textToSpeech = require("@google-cloud/text-to-speech");

// ---------- Config ----------
const NARRATIONS_PATH = path.join(__dirname, "narrations.json");
const TAFSIR_OUTPUT_DIR = path.join(__dirname, "narration-audio");
const TRANSLATION_OUTPUT_DIR = path.join(__dirname, "translation-audio");

// Must match the `id` values in index.html's TRANSLATIONS array.
const KNOWN_TRANSLATIONS = ["en.sahih", "en.yusufali", "en.pickthall", "en.hilali"];
const DEFAULT_TRANSLATION = "en.sahih"; // matches the app's own default

// A few good Neural2 English voices to choose from. Swap via --voice=.
// Full list: https://cloud.google.com/text-to-speech/docs/voices
const VOICE_OPTIONS = {
  "en-US-Neural2-D": "US male, calm and warm",
  "en-US-Neural2-J": "US male, deeper",
  "en-US-Neural2-F": "US female, warm",
  "en-GB-Neural2-B": "UK male",
  "en-GB-Neural2-A": "UK female"
};

const DEFAULT_VOICE = "en-US-Neural2-D";
const DEFAULT_CONCURRENCY = 5;
const MAX_RETRIES = 3;

// ---------- CLI args ----------
function parseArgs() {
  const args = {
    kind: "tafsir",
    surah: null,
    voice: DEFAULT_VOICE,
    concurrency: DEFAULT_CONCURRENCY,
    translation: DEFAULT_TRANSLATION
  };
  process.argv.slice(2).forEach((arg) => {
    const [key, val] = arg.replace(/^--/, "").split("=");
    if (key === "kind") args.kind = val;
    if (key === "surah") args.surah = val.split(",").map((n) => n.trim());
    if (key === "voice") args.voice = val;
    if (key === "concurrency") args.concurrency = parseInt(val, 10) || DEFAULT_CONCURRENCY;
    if (key === "translation") args.translation = val;
  });
  return args;
}

// ---------- Simple concurrency-limited queue ----------
async function runWithConcurrency(items, limit, worker) {
  let idx = 0;
  let active = 0;
  let resolveAll;
  const done = new Promise((res) => (resolveAll = res));
  const results = { ok: 0, skipped: 0, failed: 0, totalChars: 0 };

  function next() {
    if (idx >= items.length && active === 0) {
      resolveAll();
      return;
    }
    while (active < limit && idx < items.length) {
      const item = items[idx++];
      active++;
      worker(item)
        .then((r) => {
          if (r.status === "ok") results.ok++;
          else if (r.status === "skipped") results.skipped++;
          else results.failed++;
          results.totalChars += r.chars || 0;
        })
        .catch(() => { results.failed++; })
        .finally(() => {
          active--;
          next();
        });
    }
  }
  next();
  await done;
  return results;
}

// ---------- Retry helper ----------
async function withRetries(fn, retries) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        const backoffMs = 500 * Math.pow(2, attempt - 1);
        await new Promise((r) => setTimeout(r, backoffMs));
      }
    }
  }
  throw lastErr;
}

// ---------- Job list builders ----------
function buildTafsirJobs(surahNumbers) {
  if (!fs.existsSync(NARRATIONS_PATH)) {
    console.error(`Could not find narrations.json at ${NARRATIONS_PATH}`);
    process.exit(1);
  }
  const narrations = JSON.parse(fs.readFileSync(NARRATIONS_PATH, "utf8"));
  const surahs = surahNumbers || Object.keys(narrations).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));

  const jobs = [];
  surahs.forEach((surahNum) => {
    const surah = narrations[surahNum];
    if (!surah) {
      console.warn(`Surah ${surahNum} not found in narrations.json, skipping.`);
      return;
    }
    Object.keys(surah.verses)
      .sort((a, b) => parseInt(a, 10) - parseInt(b, 10))
      .forEach((verseNum) => {
        jobs.push({
          surahNum,
          verseNum,
          text: surah.verses[verseNum],
          outPath: path.join(TAFSIR_OUTPUT_DIR, surahNum, `${verseNum}.mp3`)
        });
      });
  });
  return jobs;
}

async function buildTranslationJobs(surahNumbers, edition) {
  if (!KNOWN_TRANSLATIONS.includes(edition)) {
    console.warn(`Warning: "${edition}" isn't one of the app's known editions `
      + `(${KNOWN_TRANSLATIONS.join(", ")}). Proceeding anyway, but make sure `
      + `this id is a valid api.alquran.cloud edition identifier.`);
  }

  const surahs = surahNumbers || Array.from({ length: 114 }, (_, i) => String(i + 1));
  const jobs = [];
  const outDir = path.join(TRANSLATION_OUTPUT_DIR, edition);

  for (const surahNum of surahs) {
    const url = `https://api.alquran.cloud/v1/surah/${surahNum}/${edition}`;
    let data;
    try {
      data = await withRetries(async () => {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (json.code !== 200 || !json.data || !json.data.ayahs) {
          throw new Error("Unexpected API response shape");
        }
        return json.data;
      }, MAX_RETRIES);
    } catch (err) {
      console.error(`Could not fetch surah ${surahNum} translation text: ${err.message}`);
      continue;
    }

    data.ayahs.forEach((ayah) => {
      const verseNum = String(ayah.numberInSurah);
      jobs.push({
        surahNum,
        verseNum,
        text: ayah.text,
        outPath: path.join(outDir, surahNum, `${verseNum}.mp3`)
      });
    });
  }
  return jobs;
}

// ---------- Main ----------
async function main() {
  const args = parseArgs();

  if (args.kind !== "tafsir" && args.kind !== "translation") {
    console.error(`--kind must be "tafsir" or "translation", got "${args.kind}"`);
    process.exit(1);
  }

  if (!VOICE_OPTIONS[args.voice]) {
    console.warn(`Warning: "${args.voice}" is not in the known-good list. Proceeding anyway — `
      + `Google will error out if it's not a real voice name.`);
  }

  console.log(`Kind: ${args.kind}`);
  if (args.kind === "translation") console.log(`Translation edition: ${args.translation}`);
  console.log(`Voice: ${args.voice} (${VOICE_OPTIONS[args.voice] || "custom"})`);
  console.log(`Surahs: ${args.surah ? args.surah.join(", ") : "all 114"}`);
  console.log(`Concurrency: ${args.concurrency}`);

  let jobs;
  if (args.kind === "tafsir") {
    jobs = buildTafsirJobs(args.surah);
  } else {
    console.log("Fetching translation text from api.alquran.cloud…");
    jobs = await buildTranslationJobs(args.surah, args.translation);
  }

  console.log(`Verses queued: ${jobs.length}`);
  console.log("");

  const client = new textToSpeech.TextToSpeechClient();
  let completed = 0;

  const results = await runWithConcurrency(jobs, args.concurrency, async (job) => {
    completed++;
    const label = `[${completed}/${jobs.length}] surah ${job.surahNum} verse ${job.verseNum}`;

    if (fs.existsSync(job.outPath) && fs.statSync(job.outPath).size > 0) {
      console.log(`${label} — already exists, skipping`);
      return { status: "skipped" };
    }

    try {
      const audioContent = await withRetries(async () => {
        const [response] = await client.synthesizeSpeech({
          input: { text: job.text },
          voice: { languageCode: args.voice.slice(0, 5), name: args.voice },
          audioConfig: { audioEncoding: "MP3", speakingRate: 0.96 }
        });
        return response.audioContent;
      }, MAX_RETRIES);

      fs.mkdirSync(path.dirname(job.outPath), { recursive: true });
      fs.writeFileSync(job.outPath, audioContent, "binary");
      console.log(`${label} — done (${job.text.length} chars)`);
      return { status: "ok", chars: job.text.length };
    } catch (err) {
      console.error(`${label} — FAILED: ${err.message}`);
      return { status: "failed" };
    }
  });

  console.log("");
  console.log("---- Summary ----");
  console.log(`Generated:  ${results.ok}`);
  console.log(`Skipped:    ${results.skipped} (already existed)`);
  console.log(`Failed:     ${results.failed}`);
  console.log(`Characters billed this run: ${results.totalChars.toLocaleString()}`);
  console.log(`(Google Cloud Neural2 free tier: 1,000,000 characters/month)`);
  if (results.failed > 0) {
    console.log("");
    console.log("Some verses failed — just re-run the same command; completed");
    console.log("verses are skipped automatically, so it'll only retry the failures.");
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
