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
    const p = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });

    let err = "";
    p.stderr.on("data", (d) => (err += d.toString()));

    p.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(err));
    });
  });
}

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

async function imagesPlusAudioToMp4(imagePath, audioPath, outMp4) {
  const W = 1280;
  const H = 720;
  const fps = 30;

  await runCmd("ffmpeg", [
    "-y",
    "-loop", "1",
    "-i", imagePath,
    "-i", audioPath,
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-tune", "stillimage",
    "-pix_fmt", "yuv420p",
    "-vf", `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`,
    "-c:a", "aac",
    "-b:a", "128k",
    "-shortest",
    outMp4,
  ]);
}

app.post("/render10min/start", async (req, res) => {
  try {
    if (!req.body?.text) {
      return res.status(400).json({ error: "Missing text field" });
    }

    const jobId = uid();
    const jobDir = path.join(os.tmpdir(), `render_${jobId}`);
    await fsp.mkdir(jobDir, { recursive: true });

    const imagePath = path.join(process.cwd(), "assets", "sabit.jpg");
    if (!fs.existsSync(imagePath)) {
      return res.status(400).json({ error: "assets/sabit.jpg not found" });
    }

    jobs.set(jobId, { status: "processing" });

    setImmediate(async () => {
      try {
        const wavPath = path.join(jobDir, "audio.wav");
        const mp4Path = path.join(jobDir, "output.mp4");

        await ttsToWav(req.body.text, wavPath);
        await imagesPlusAudioToMp4(imagePath, wavPath, mp4Path);

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

app.get("/render10min/status/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "job_not_found" });
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
  console.log("Server running on port " + PORT);
});
