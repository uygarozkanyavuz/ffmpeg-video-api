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

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

const jobs = new Map();

function uid() {
  return crypto.randomUUID
    ? crypto.randomBytes(16).toString("hex")
    : crypto.randomUUID();
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
    "-filter:a", "atempo=0.85",
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

async function imagesPlusAudio(imagePaths, audioPath, outMp4) {

  const duration = await ffprobeDuration(audioPath);
  const perImage = duration / imagePaths.length;

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
  filters.push(`${concatRefs}concat=n=${imagePaths.length}:v=1:a=0[vout]`);

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

async function processJob(jobId, jobDir, bgPaths, storyText) {
  try {
    const clipsDir = path.join(jobDir, "clips");
    await fsp.mkdir(clipsDir, { recursive: true });

    const raw = path.join(clipsDir, "tts_raw.wav");
    const norm = path.join(clipsDir, "tts.wav");
    const audioM4a = path.join(jobDir, "audio.m4a");

    await ttsToWav(storyText, raw);
    await normalizeToWav(raw, norm);
    await wavToM4a(norm, audioM4a);

    const outMp4 = path.join(jobDir, "output.mp4");
    await imagesPlusAudio(bgPaths, audioM4a, outMp4);

    jobs.get(jobId).status = "done";
    jobs.get(jobId).outputPath = outMp4;

  } catch (err) {
    jobs.get(jobId).status = "error";
    jobs.get(jobId).error = err.message;
  }
}

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
