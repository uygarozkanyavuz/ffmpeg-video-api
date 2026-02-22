/* server.js */

const express = require("express");
const multer = require("multer");
const path = require("path");
const os = require("os");
const fs = require("fs");
const fsp = require("fs/promises");
const { spawn } = require("child_process");
const crypto = require("crypto");
const OpenAI = require("openai");

const app = express();
const PORT = process.env.PORT || 3000;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

const jobs = new Map();

function uid() {
  return crypto.randomBytes(16).toString("hex");
}

function runCmd(bin, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args);
    let err = "";
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(err));
    });
  });
}

async function writeFileSafe(filePath, buffer) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, buffer);
}

async function ffprobeDuration(filePath) {
  return new Promise((resolve) => {
    const p = spawn("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      filePath,
    ]);

    let out = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.on("close", () => {
      resolve(Number(out.trim()) || 0);
    });
  });
}

/* ---------------- TTS ---------------- */

async function ttsToWav(text, wavPath) {
  if (!text || text === "undefined") {
    throw new Error("storyText is empty or undefined");
  }

  const response = await openai.audio.speech.create({
    model: "gpt-4o-mini-tts",
    voice: "marin",
    input: text,
    response_format: "wav",
  });

  const buf = Buffer.from(await response.arrayBuffer());
  await writeFileSafe(wavPath, buf);
}

async function normalizeToWav(inPath, outPath) {
  await runCmd("ffmpeg", [
    "-y",
    "-i", inPath,
    "-filter:a", "atempo=0.9",
    "-ar", "48000",
    "-ac", "1",
    "-c:a", "pcm_s16le",
    outPath,
  ]);
}

async function wavToM4a(inWav, outM4a) {
  await runCmd("ffmpeg", [
    "-y",
    "-i", inWav,
    "-c:a", "aac",
    "-b:a", "192k",
    outM4a,
  ]);
}

/* ---------------- SRT ---------------- */

function secondsToSrtTime(sec) {
  const date = new Date(sec * 1000);
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  const ss = String(date.getUTCSeconds()).padStart(2, "0");
  const ms = String(date.getUTCMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss},${ms}`;
}

async function createSrtFile(text, audioDuration, srtPath) {

  const sentences = text
    .replace(/\n+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(Boolean);

  if (!sentences.length) throw new Error("No subtitle sentences found");

  const totalChars = sentences.reduce((sum, s) => sum + s.length, 0);

  let current = 0;
  let srt = "";

  sentences.forEach((sentence, i) => {

    const ratio = sentence.length / totalChars;
    const duration = audioDuration * ratio;

    const start = current;
    const end = current + duration;

    srt += `${i + 1}\n`;
    srt += `${secondsToSrtTime(start)} --> ${secondsToSrtTime(end)}\n`;
    srt += `${sentence}\n\n`;

    current = end;
  });

  await fsp.writeFile(srtPath, srt);
}

/* ---------------- VIDEO ---------------- */

async function imagesPlusAudio(imagePaths, audioPath, outMp4, storyText) {

  const duration = await ffprobeDuration(audioPath);
  const perImage = duration / imagePaths.length;

  const jobDir = path.dirname(outMp4);
  const srtPath = path.join(jobDir, "subtitles.srt");

  await createSrtFile(storyText, duration, srtPath);

  const args = ["-y"];

  for (const img of imagePaths) {
    args.push(
      "-loop", "1",
      "-t", perImage.toString(),
      "-i", img
    );
  }

  const audioIndex = imagePaths.length;
  args.push("-i", audioPath);

  const filters = [];

  for (let i = 0; i < imagePaths.length; i++) {
    filters.push(
      `[${i}:v]scale=1280:720,setsar=1[v${i}]`
    );
  }

  const concatRefs = imagePaths.map((_, i) => `[v${i}]`).join("");
  filters.push(`${concatRefs}concat=n=${imagePaths.length}:v=1:a=0[vtmp]`);

  // Daha küçük ve dengeli altyazı
  filters.push(
    `[vtmp]subtitles=${srtPath}:force_style='FontSize=24,PrimaryColour=&Hffffff&,OutlineColour=&H000000&,BorderStyle=3,Outline=1,Shadow=0,Alignment=2,MarginV=40'[vout]`
  );

  args.push(
    "-filter_complex", filters.join(";"),
    "-map", "[vout]",
    "-map", `${audioIndex}:a`,
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-shortest",
    outMp4
  );

  await runCmd("ffmpeg", args);
}

/* ---------------- JOB PROCESS ---------------- */

async function processJob(jobId, jobDir, bgPaths, storyText) {
  try {
    const clipsDir = path.join(jobDir, "clips");
    await fsp.mkdir(clipsDir, { recursive: true });

    const raw = path.join(clipsDir, "tts_raw.wav");
    const norm = path.join(clipsDir, "tts.wav");
    const audioM4a = path.join(jobDir, "audio.m4a");
    const outMp4 = path.join(jobDir, "output.mp4");

    await ttsToWav(storyText, raw);
    await normalizeToWav(raw, norm);
    await wavToM4a(norm, audioM4a);

    await imagesPlusAudio(bgPaths, audioM4a, outMp4, storyText);

    jobs.set(jobId, {
      status: "done",
      outputPath: outMp4,
    });

  } catch (err) {
    jobs.set(jobId, {
      status: "error",
      error: err.message,
    });
  }
}

/* ---------------- ROUTES ---------------- */

app.post("/render10min/start", upload.any(), async (req, res) => {
  try {

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "OPENAI_API_KEY missing" });
    }

    const storyText = (req.body?.storyText || "").trim();
    if (!storyText) {
      return res.status(400).json({ error: "storyText missing" });
    }

    const files = Array.isArray(req.files) ? req.files : [];
    if (!files.length) {
      return res.status(400).json({ error: "No image uploaded" });
    }

    const jobId = uid();
    const jobDir = path.join(os.tmpdir(), `job_${jobId}`);
    await fsp.mkdir(jobDir, { recursive: true });

    const bgPaths = [];

    for (let i = 0; i < files.length; i++) {
      const p = path.join(jobDir, `bg_${i + 1}.png`);
      await writeFileSafe(p, files[i].buffer);
      bgPaths.push(p);
    }

    jobs.set(jobId, { status: "processing" });

    setImmediate(() =>
      processJob(jobId, jobDir, bgPaths, storyText)
    );

    res.json({ jobId });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/render10min/status/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "not_found" });
  res.json(job);
});

app.get("/render10min/result/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || job.status !== "done") {
    return res.status(404).json({ error: "not_ready" });
  }

  res.setHeader("Content-Type", "video/mp4");
  fs.createReadStream(job.outputPath).pipe(res);
});

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
