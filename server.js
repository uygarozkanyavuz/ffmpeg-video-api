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
app.use(express.urlencoded({ limit: "100mb", extended: true }));

if (!process.env.OPENAI_API_KEY) {
  throw new Error("OPENAI_API_KEY missing");
}

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const JOB_ROOT = path.join(os.tmpdir(), "render_jobs");

/* ---------------- UTIL ---------------- */

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

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

async function transcribe(audioPath) {
  const transcription = await openai.audio.transcriptions.create({
    file: fs.createReadStream(audioPath),
    model: "whisper-1",
    response_format: "verbose_json",
  });

  return transcription.segments || [];
}

/* ---------------- ASS SUBTITLE ---------------- */

async function createKaraokeAss(segments, assPath) {
  let ass = `[Script Info]
ScriptType: v4.00+
PlayResX: 1280
PlayResY: 720

[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: Default,Montserrat,56,&H00FFFFFF,&H0000FF00,&H00000000,&H00000000,1,0,1,4,0,2,10,10,60,1

[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
`;

  for (const seg of segments) {
    const start = secondsToAss(seg.start);
    const end = secondsToAss(seg.end);

    const words = seg.text.trim().split(" ");
    const duration = seg.end - seg.start;
    const perWord = (duration / words.length) * 0.9;

    let karaoke = "";

    for (const word of words) {
      const k = Math.floor(perWord * 100);
      karaoke += `{\\k${k}}${word} `;
    }

    ass += `Dialogue: 0,${start},${end},Default,,0,0,0,,${karaoke.trim()}\n`;
  }

  await fsp.writeFile(assPath, ass);
}

function secondsToAss(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = (sec % 60).toFixed(2);

  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(5, "0")}`;
}

/* ---------------- VIDEO ---------------- */

async function ffprobeDuration(filePath) {
  return new Promise((resolve) => {
    const p = spawn("ffprobe", [
      "-v","error",
      "-show_entries","format=duration",
      "-of","default=noprint_wrappers=1:nokey=1",
      filePath
    ]);

    let out = "";
    p.stdout.on("data",(d)=> out += d.toString());
    p.on("close",()=> resolve(Number(out.trim()) || 0));
  });
}

async function imagesPlusAudioToMp4(imagePath, audioPath, outMp4, assPath) {

  const duration = await ffprobeDuration(audioPath);

  await runCmd("ffmpeg", [
    "-y",
    "-loop","1",
    "-t",duration.toString(),
    "-i",imagePath,
    "-i",audioPath,
    "-vf",`scale=1280:720,ass=${assPath}`,
    "-map","0:v",
    "-map","1:a",
    "-c:v","libx264",
    "-preset","veryfast",
    "-tune","stillimage",
    "-pix_fmt","yuv420p",
    "-c:a","aac",
    "-b:a","128k",
    "-shortest",
    outMp4
  ]);
}

/* ---------------- ROUTES ---------------- */

app.post("/render10min/start", async (req,res)=>{

  try{

    if(!req.body?.text)
      return res.status(400).json({error:"Missing text"});

    await ensureDir(JOB_ROOT);

    const jobId = uid();
    const jobDir = path.join(JOB_ROOT,jobId);

    await ensureDir(jobDir);

    const statusFile = path.join(jobDir,"status.json");

    await fsp.writeFile(statusFile,JSON.stringify({status:"processing"}));

    const imagePath = path.join(process.cwd(),"assets","sabit.jpg");

    setImmediate(async()=>{

      try{

        const wavPath = path.join(jobDir,"audio.wav");
        const assPath = path.join(jobDir,"subtitles.ass");
        const mp4Path = path.join(jobDir,"output.mp4");

        // 🔥 TTS (normal hız)
        await ttsToWav(req.body.text,wavPath);

        // 🔥 direkt transcription
        const segments = await transcribe(wavPath);

        await createKaraokeAss(segments,assPath);

        await imagesPlusAudioToMp4(imagePath,wavPath,mp4Path,assPath);

        await fsp.writeFile(statusFile,JSON.stringify({
          status:"done",
          outputPath:mp4Path
        }));

      }catch(err){

        await fsp.writeFile(statusFile,JSON.stringify({
          status:"error",
          error:err.message
        }));
      }

    });

    res.json({jobId});

  }catch(err){
    res.status(500).json({error:err.message});
  }

});

/* STATUS */

app.get("/render10min/status/:jobId", async (req,res)=>{

  const jobDir = path.join(JOB_ROOT,req.params.jobId);
  const statusFile = path.join(jobDir,"status.json");

  if(!fs.existsSync(statusFile))
    return res.status(404).json({error:"job_not_found"});

  const data = JSON.parse(await fsp.readFile(statusFile));
  res.json(data);
});

/* RESULT */

app.get("/render10min/result/:jobId", async (req,res)=>{

  const jobDir = path.join(JOB_ROOT,req.params.jobId);
  const statusFile = path.join(jobDir,"status.json");

  if(!fs.existsSync(statusFile))
    return res.status(404).json({error:"job_not_found"});

  const status = JSON.parse(await fsp.readFile(statusFile));

  if(status.status !== "done")
    return res.status(404).json({error:"not_ready"});

  res.setHeader("Content-Type","video/mp4");

  fs.createReadStream(status.outputPath).pipe(res);
});

app.listen(PORT,()=>{
  console.log("Server running on port "+PORT);
});
