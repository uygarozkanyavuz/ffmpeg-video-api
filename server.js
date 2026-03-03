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

app.use(express.json({ limit: "100mb" }));

if (!process.env.OPENAI_API_KEY) {
  throw new Error("OPENAI_API_KEY missing");
}

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const jobs = new Map();

function uid() {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : crypto.randomBytes(16).toString("hex");
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

/* ---------------- TTS ---------------- */

async function ttsToWav(text, wavPath) {
  const resp = await openai.audio.speech.create({
    model: "gpt-4o-mini-tts",
    voice: "marin",
    input: text,
    response_format: "wav",
  });

  const buf = Buffer.from(await resp.arrayBuffer());
  await fsp.writeFile(wavPath, buf);
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
    if (segment.start === undefined) continue;

    const start = segment.start;
    const end = segment.end > start ? segment.end : start + 1;
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
    p.on("close", () => resolve(Number(out.trim()) || 0));
  });
}

async function imagesPlusAudioToMp4(imagePath, audioPath, outMp4, srtPath) {
  const duration = await ffprobeDuration(audioPath);
  const safeSrtPath = srtPath.replace(/\\/g, "\\\\").replace(/:/g, "\\:");

  await runCmd("ffmpeg", [
    "-y",
    "-loop", "1",
    "-t", duration.toString(),
    "-i", imagePath,
    "-i", audioPath,
    "-filter_complex",
    `[0:v]scale=1280:720,setsar=1[v0];` +
    `[v0]subtitles=${safeSrtPath}:force_style='FontSize=28,PrimaryColour=&Hffffff&,OutlineColour=&H000000&,BorderStyle=3,Outline=1,Shadow=0,Alignment=2,MarginV=40'[vout]`,
    "-map", "[vout]",
    "-map", "1:a",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-tune", "stillimage",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "128k",
    "-shortest",
    outMp4
  ]);
}

/* ---------------- ROUTE ---------------- */

app.post("/render10min/start", async (req, res) => {
  try {
    if (!req.body?.text) {
      return res.status(400).json({ error: "Missing text field" });
    }

    const imagePath = path.join(process.cwd(), "assets", "sabit.jpg");
    if (!fs.existsSync(imagePath)) {
      return res.status(400).json({ error: "assets/sabit.jpg not found" });
    }

    const jobId = uid();
    const jobDir = path.join(os.tmpdir(), `render_${jobId}`);
    await fsp.mkdir(jobDir, { recursive: true });

    jobs.set(jobId, { status: "processing" });

    setImmediate(async () => {
      try {
        const wavPath = path.join(jobDir, "audio.wav");
        const srtPath = path.join(jobDir, "subtitles.srt");
        const mp4Path = path.join(jobDir, "output.mp4");

        await ttsToWav(req.body.text, wavPath);

        const segments = await transcribeWithTimestamps(wavPath);
        await createSentenceLevelSrt(segments, srtPath);

        await imagesPlusAudioToMp4(imagePath, wavPath, mp4Path, srtPath);

        jobs.set(jobId, {
          status: "done",
          outputPath: mp4Path,
        });
      } catch (err) {
        jobs.set(jobId, {
          status: "error",
          error: err.message,
        });
      }
    });

    res.json({ jobId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* STATUS */
app.get("/render10min/status/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "job_not_found" });
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
  console.log("Server running on port " + PORT);
});
