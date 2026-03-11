const ytdl = require("@distube/ytdl-core");
const ffmpegInstaller = require("@ffmpeg-installer/ffmpeg");
const ffmpeg = require("fluent-ffmpeg");
const path = require("path");
const fs = require("fs");
const os = require("os");

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

async function getVideoInfo(url) {
  try {
    const info = await ytdl.getInfo(url);
    const details = info.videoDetails;
    return {
      title: details.title,
      author: details.author?.name,
      duration: details.lengthSeconds,
      views: details.viewCount,
      url: details.video_url,
      thumbnail: details.thumbnails?.slice(-1)[0]?.url,
    };
  } catch (err) {
    throw new Error(`Could not fetch video info: ${err.message}`);
  }
}

async function downloadAudio(url) {
  const tmpDir = os.tmpdir();
  const rawPath = path.join(tmpDir, `audio_raw_${Date.now()}.webm`);
  const outPath = path.join(tmpDir, `audio_${Date.now()}.mp3`);

  const info = await ytdl.getInfo(url);
  const title = info.videoDetails.title.slice(0, 60);

  await new Promise((resolve, reject) => {
    const stream = ytdl.downloadFromInfo(info, { quality: "highestaudio", filter: "audioonly" });
    const out = fs.createWriteStream(rawPath);
    stream.pipe(out);
    out.on("finish", resolve);
    stream.on("error", reject);
    out.on("error", reject);
  });

  await new Promise((resolve, reject) => {
    ffmpeg(rawPath)
      .audioCodec("libmp3lame")
      .audioBitrate(128)
      .on("end", resolve)
      .on("error", reject)
      .save(outPath);
  });

  fs.unlinkSync(rawPath);
  return { path: outPath, title };
}

async function downloadVideo(url) {
  const tmpDir = os.tmpdir();
  const outPath = path.join(tmpDir, `video_${Date.now()}.mp4`);

  const info = await ytdl.getInfo(url);
  const title = info.videoDetails.title.slice(0, 60);

  await new Promise((resolve, reject) => {
    ytdl
      .downloadFromInfo(info, {
        quality: "highestvideo",
        filter: (fmt) => fmt.container === "mp4" && fmt.hasAudio && fmt.hasVideo,
      })
      .on("error", () => {
        ytdl
          .downloadFromInfo(info, { quality: "highest" })
          .pipe(fs.createWriteStream(outPath))
          .on("finish", resolve)
          .on("error", reject);
      })
      .pipe(fs.createWriteStream(outPath))
      .on("finish", resolve)
      .on("error", reject);
  });

  return { path: outPath, title };
}

async function searchYouTube(query) {
  try {
    const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
    const axios = require("axios");
    const res = await axios.get(searchUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
      timeout: 10000,
    });
    const html = res.data;
    const match = html.match(/var ytInitialData = (.+?);<\/script>/);
    if (match) {
      const data = JSON.parse(match[1]);
      const videos =
        data?.contents?.twoColumnSearchResultsRenderer?.primaryContents
          ?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents || [];
      const results = [];
      for (const item of videos) {
        const v = item?.videoRenderer;
        if (v && results.length < 5) {
          results.push({
            title: v.title?.runs?.[0]?.text,
            url: `https://www.youtube.com/watch?v=${v.videoId}`,
            duration: v.lengthText?.simpleText,
            channel: v.ownerText?.runs?.[0]?.text,
            views: v.viewCountText?.simpleText,
          });
        }
      }
      return results;
    }
  } catch {}
  return [];
}

async function downloadFacebook(url) {
  const axios = require("axios");
  const FormData = require("form-data");

  const form = new FormData();
  form.append("URLz", url);
  const res = await axios.post("https://fdown.net/download.php", form, {
    headers: form.getHeaders(),
    timeout: 15000,
  });
  const html = res.data;
  const hdMatch = html.match(/href="([^"]+)" id="hdlink"/);
  const sdMatch = html.match(/href="([^"]+)" id="sdlink"/);
  const videoUrl = hdMatch?.[1] || sdMatch?.[1];
  if (!videoUrl) throw new Error("Could not extract Facebook video URL. Make sure the video is public.");

  const tmpDir = os.tmpdir();
  const outPath = path.join(tmpDir, `fb_video_${Date.now()}.mp4`);
  const writer = fs.createWriteStream(outPath);
  const videoRes = await axios({ url: videoUrl, method: "GET", responseType: "stream", timeout: 60000 });
  videoRes.data.pipe(writer);
  await new Promise((resolve, reject) => {
    writer.on("finish", resolve);
    writer.on("error", reject);
  });
  return { path: outPath, title: "Facebook Video", type: "video" };
}

async function downloadPinterest(url) {
  const axios = require("axios");
  const res = await axios.get(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "Accept-Language": "en-US,en;q=0.9",
    },
    timeout: 12000,
  });
  const html = res.data;

  const videoMatch = html.match(/"url":"(https:\/\/v\.pinimg\.com[^"]+\.mp4[^"]*)"/);
  if (videoMatch) {
    const videoUrl = videoMatch[1].replace(/\\u002F/g, "/").replace(/\\/g, "");
    const tmpDir = os.tmpdir();
    const outPath = path.join(tmpDir, `pin_video_${Date.now()}.mp4`);
    const writer = fs.createWriteStream(outPath);
    const videoRes = await axios({ url: videoUrl, method: "GET", responseType: "stream", timeout: 60000 });
    videoRes.data.pipe(writer);
    await new Promise((resolve, reject) => {
      writer.on("finish", resolve);
      writer.on("error", reject);
    });
    return { path: outPath, title: "Pinterest Video", type: "video" };
  }

  const imgMatch = html.match(/<meta property="og:image" content="([^"]+)"/) ||
                   html.match(/"og:image","content":"([^"]+)"/);
  if (imgMatch) {
    const imgUrl = imgMatch[1];
    const imgRes = await axios.get(imgUrl, { responseType: "arraybuffer", timeout: 15000 });
    return { buffer: Buffer.from(imgRes.data), title: "Pinterest Image", type: "image" };
  }

  throw new Error("Could not find media in that Pinterest URL. Make sure the pin is public.");
}

module.exports = { getVideoInfo, downloadAudio, downloadVideo, searchYouTube, downloadFacebook, downloadPinterest };
