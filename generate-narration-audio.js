// generate-narration-audio.js
//
// Generates one MP3 per verse from narrations.json using Google Cloud
// Text-to-Speech (Neural2 voices). Output layout matches what index.html
// expects:
//     narration-audio/<surahNumber>/<verseNumber>.mp3
//
// Usage:
//   node generate-narration-audio.js                  // all 114 surahs
//   node generate-narration-audio.js --surah=24        // just one surah
//   node generate-narration-audio.js --surah=24,25,33   // a few surahs
//   node generate-narration-audio.js --voice=en-US-Neural2-J
//   node generate-narration-audio.js --concurrency=8
//
// Re-running is safe: any verse whose MP3 already exists is skipped, so
// you can stop and resume freely, or re-run after adding new surahs to
// narrations.json.
//
// Setup (one-time):
//   1. Create/select a project at https://console.cloud.google.com
//   2. Enable the "Cloud Text-to-Speech API" for that project
//   3. Create a service account with the "Cloud Text-to-Speech User" role
//   4. Create a JSON key for it and download it
//   5. Set the environment variable before running:
//        export GOOGLE_APPLICATION_CREDENTIALS="/path/to/key.json"
//   6. npm install
//   7. npm run generate

"use strict";

const fs = require("fs");
const path = require("path");
const textToSpeech = require("@google-cloud/text-to-speech");

// ---------- Config ----------
const NARRATIONS_PATH = path.join(__dirname, "narrations.json");
const OUTPUT_DIR = path.join(__dirname, "narration-audio");

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
  const args = { surah: null, voice: DEFAULT_VOICE, concurrency: DEFAULT_CONCURRENCY };
  process.argv.slice(2).forEach((arg) => {
    const [key, val] = arg.replace(/^--/, "").split("=");
    if (key === "surah") args.surah = val.split(",").map((n) => n.trim());
    if (key === "voice") args.voice = val;
    if (key === "concurrency") args.concurrency = parseInt(val, 10) || DEFAULT_CONCURRENCY;
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

// ---------- Main ----------
async function main() {
  const args = parseArgs();

  if (!VOICE_OPTIONS[args.voice]) {
    console.warn(`Warning: "${args.voice}" is not in the known-good list. Proceeding anyway — `
      + `Google will error out if it's not a real voice name.`);
  }

  if (!fs.existsSync(NARRATIONS_PATH)) {
    console.error(`Could not find narrations.json at ${NARRATIONS_PATH}`);
    process.exit(1);
  }

  const narrations = JSON.parse(fs.readFileSync(NARRATIONS_PATH, "utf8"));
  const client = new textToSpeech.TextToSpeechClient();

  const surahNumbers = args.surah
    ? args.surah
    : Object.keys(narrations).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));

  // Flatten every verse across the selected surahs into one job list.
  const jobs = [];
  surahNumbers.forEach((surahNum) => {
    const surah = narrations[surahNum];
    if (!surah) {
      console.warn(`Surah ${surahNum} not found in narrations.json, skipping.`);
      return;
    }
    Object.keys(surah.verses)
      .sort((a, b) => parseInt(a, 10) - parseInt(b, 10))
      .forEach((verseNum) => {
        jobs.push({ surahNum, verseNum, text: surah.verses[verseNum] });
      });
  });

  console.log(`Voice: ${args.voice} (${VOICE_OPTIONS[args.voice] || "custom"})`);
  console.log(`Surahs: ${args.surah ? args.surah.join(", ") : "all 114"}`);
  console.log(`Verses queued: ${jobs.length}`);
  console.log(`Concurrency: ${args.concurrency}`);
  console.log("");

  let completed = 0;

  const results = await runWithConcurrency(jobs, args.concurrency, async (job) => {
    const surahDir = path.join(OUTPUT_DIR, job.surahNum);
    const outPath = path.join(surahDir, `${job.verseNum}.mp3`);

    completed++;
    const label = `[${completed}/${jobs.length}] surah ${job.surahNum} verse ${job.verseNum}`;

    if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
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

      fs.mkdirSync(surahDir, { recursive: true });
      fs.writeFileSync(outPath, audioContent, "binary");
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
