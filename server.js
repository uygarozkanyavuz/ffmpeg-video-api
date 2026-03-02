/* server.js - SENTENCE LEVEL SUBTITLE VERSION (FIXED IMAGE + 50MB BODY) */

const express = require("express");
const path = require("path");
const os = require("os");
const fs = require("fs");
const fsp = require("fs/promises");
const { spawn } = require("child_process");
const crypto = require("crypto");
const OpenAI = require("openai");

const app = express();
const PORT = process.env.PORT || 3000;

/* ---------------- BODY LIMIT 50MB ---------------- */

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

/* ---------------- SETTINGS ---------------- */

const AUDIO_ATEMPO = 0.80;
const FIXED_IMAGE_PATH = path.join(__dirname, "assets", "sabit.png");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const jobs = new Map();

/* ---------------- UTIL ---------------- */

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

/* ---------------- TTS ---------------- */

async function ttsToWav(text, wavPath) {
  const response = await openai.audio.speech.create({
    model: "gpt-4o-mini-tts",
    voice: "marin",
    input: text,
    response_format: "wav",
  });

  const buf = Buffer.from(await response.arrayBuffer());
  await writeFileSafe(wavPath, buf);
}

/* ---------------- WHISPER ---------------- */

async function transcribeWithTimestamps(audioPath) {
  const transcription = await openai.audio.transcriptions.create({
    file: fs.createReadStream(audioPath),
    model: "whisper-1",
    response_format: "verbose_json",
  });

  return transcription.segments || [];
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

async function createSentenceLevelSrt(segments, srtPath) {
  let srt = "";
  let index = 1;

  for (const segment of segments) {
    let start = segment.start;
    let end = segment.end;

    if (start === undefined) continue;
    if (!end || end <= start) end = start + 1;

    const text = (segment.text || "").trim();
    if (!text) continue;

    srt += `${index}\n`;
    srt += `${secondsToSrtTime(start)} --> ${secondsToSrtTime(end)}\n`;
    srt += `${text}\n\n`;

    index++;
  }

  await fsp.writeFile(srtPath, srt);
}

/* ---------------- VIDEO ---------------- */

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

async function imagePlusAudio(imagePath, audioPath, outMp4, srtPath) {
  const duration = await ffprobeDuration(audioPath);

  const args = [
    "-y",
    "-loop", "1",
    "-t", duration.toString(),
    "-i", imagePath,
    "-i", audioPath,
    "-filter_complex",
    `[0:v]scale=1280:720,setsar=1[v0];` +
    `[v0]subtitles=${srtPath}:force_style='FontSize=24,PrimaryColour=&Hffffff&,OutlineColour=&H000000&,BorderStyle=3,Outline=1,Shadow=0,Alignment=2,MarginV=40'[vout]`,
    "-map", "[vout]",
    "-map", "1:a",
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-shortest",
    outMp4
  ];

  await runCmd("ffmpeg", args);
}

/* ---------------- JOB PROCESS ---------------- */

async function processJob(jobId, jobDir, storyText) {
  try {
    const rawAudio = path.join(jobDir, "tts_raw.wav");
    const slowAudio = path.join(jobDir, "tts_slow.wav");
    const srtPath = path.join(jobDir, "subtitles.srt");
    const outMp4 = path.join(jobDir, "output.mp4");

    await ttsToWav(storyText, rawAudio);

    await runCmd("ffmpeg", [
      "-y",
      "-i", rawAudio,
      "-filter:a", `atempo=${AUDIO_ATEMPO}`,
      slowAudio
    ]);

    const segments = await transcribeWithTimestamps(slowAudio);
    await createSentenceLevelSrt(segments, srtPath);

    await imagePlusAudio(FIXED_IMAGE_PATH, slowAudio, outMp4, srtPath);

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

app.post("/render10min/start", async (req, res) => {
  try {
    console.log("BODY:", req.body);

    const storyText = (req.body?.storyText || "").trim();

    if (!storyText) {
      return res.status(400).json({ error: "storyText missing" });
    }

    if (!fs.existsSync(FIXED_IMAGE_PATH)) {
      return res.status(500).json({ error: "assets/sabit.png not found" });
    }

    const jobId = uid();
    const jobDir = path.join(os.tmpdir(), `job_${jobId}`);

    await fsp.mkdir(jobDir, { recursive: true });

    jobs.set(jobId, { status: "processing" });

    setImmediate(() =>
      processJob(jobId, jobDir, storyText)
    );

    res.json({ jobId });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* STATUS */
app.get("/render10min/status/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);

  if (!job) {
    return res.status(404).json({ error: "not_found" });
  }

  res.json(job);
});

/* RESULT */
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
