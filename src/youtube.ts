// src/youtube.ts — YouTube search with exact timestamps (no dependencies)
type Env = { YOUTUBE_API_KEY?: string };
type Video = { id: string; title: string; channel: string };
type Seg = { t: number; text: string };
type Chunk = { v: Video; segs: Seg[]; text: string; norm: string; toks: string[] };

const ANDROID_VER = "20.10.38";
const ANDROID_UA = `com.google.android.youtube/${ANDROID_VER} (Linux; U; Android 14) gzip`;

const STOP = new Set(
  ("the a an and or of to in on for is are was were be it this that with as at by from how what when where who why " +
    "في من على الى إلى عن هو هي ما ماذا متى اين أين كيف ليه لماذا هل مع ده دي دا ان أن").split(" ")
);

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه");

const tokens = (s: string) => norm(s).match(/[\p{L}\p{N}]+/gu) ?? [];

const decode = (s: string) =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");

function fmt(sec: number) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const p = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${p(m)}:${p(r)}` : `${m}:${p(r)}`;
}

function collect(obj: any, key: string, out: any[]) {
  if (!obj || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    for (const x of obj) collect(x, key, out);
    return;
  }
  for (const k of Object.keys(obj)) {
    if (k === key) out.push(obj[k]);
    else collect(obj[k], key, out);
  }
}

async function searchApi(query: string, n: number, key: string): Promise<Video[]> {
  const u = new URL("https://www.googleapis.com/youtube/v3/search");
  u.searchParams.set("part", "snippet");
  u.searchParams.set("type", "video");
  u.searchParams.set("maxResults", String(n));
  u.searchParams.set("q", query);
  u.searchParams.set("key", key);
  const r = await fetch(u.toString(), { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`YouTube API HTTP ${r.status}`);
  const j: any = await r.json();
  return (j.items ?? []).map((it: any) => ({
    id: it.id.videoId,
    title: decode(it.snippet.title),
    channel: decode(it.snippet.channelTitle),
  }));
}

async function searchInnerTube(query: string, n: number): Promise<Video[]> {
  const r = await fetch("https://www.youtube.com/youtubei/v1/search?prettyPrint=false", {
    method: "POST",
    headers: { "content-type": "application/json", "accept-language": "en-US,en;q=0.9" },
    body: JSON.stringify({
      context: { client: { clientName: "WEB", clientVersion: "2.20250101.00.00", hl: "en", gl: "US" } },
      query,
      params: "EgIQAQ==",
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`YouTube search HTTP ${r.status}`);
  const j: any = await r.json();
  const found: any[] = [];
  collect(j, "videoRenderer", found);
  const seen = new Set<string>();
  const vids: Video[] = [];
  for (const v of found) {
    if (!v?.videoId || seen.has(v.videoId)) continue;
    seen.add(v.videoId);
    vids.push({
      id: v.videoId,
      title: v.title?.runs?.[0]?.text ?? "(no title)",
      channel: v.ownerText?.runs?.[0]?.text ?? "",
    });
    if (vids.length >= n) break;
  }
  return vids;
}

async function getSegments(id: string, langs: string[]): Promise<Seg[]> {
  const r = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": ANDROID_UA,
      "x-youtube-client-name": "3",
      "x-youtube-client-version": ANDROID_VER,
    },
    body: JSON.stringify({
      context: {
        client: { clientName: "ANDROID", clientVersion: ANDROID_VER, androidSdkVersion: 34, hl: "en", gl: "US" },
      },
      videoId: id,
      contentCheckOk: true,
      racyCheckOk: true,
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`player HTTP ${r.status}`);
  const j: any = await r.json();
  const tracks: any[] = j?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  if (!tracks.length) {
    const st = j?.playabilityStatus;
    throw new Error(`no captions (${st?.status ?? "?"}${st?.reason ? ": " + st.reason : ""})`);
  }
  const pick = (manual: boolean) => {
    for (const l of langs) {
      const t = tracks.find((x) => x.languageCode?.startsWith(l) && (x.kind !== "asr") === manual);
      if (t) return t;
    }
    return tracks.find((x) => (x.kind !== "asr") === manual);
  };
  const track = pick(true) ?? pick(false) ?? tracks[0];
  const u = new URL(track.baseUrl);
  u.searchParams.set("fmt", "json3");
  const tr = await fetch(u.toString(), { signal: AbortSignal.timeout(8000) });
  const body = await tr.text();
  if (!tr.ok || !body) throw new Error(`transcript empty/blocked (HTTP ${tr.status})`);
  const data = JSON.parse(body);
  const segs: Seg[] = [];
  for (const e of data.events ?? []) {
    if (!e.segs) continue;
    const text = e.segs.map((s: any) => s.utf8 ?? "").join("").replace(/\s+/g, " ").trim();
    if (text) segs.push({ t: (e.tStartMs ?? 0) / 1000, text });
  }
  if (!segs.length) throw new Error("transcript has no text");
  return segs;
}

function makeChunks(v: Video, segs: Seg[]): Chunk[] {
  const chunks: Chunk[] = [];
  const WIN = 45;
  const STEP = 20;
  let i = 0;
  while (i < segs.length) {
    const start = segs[i].t;
    const part: Seg[] = [];
    let j = i;
    while (j < segs.length && segs[j].t < start + WIN) part.push(segs[j++]);
    const text = part.map((s) => s.text).join(" ");
    chunks.push({ v, segs: part, text, norm: norm(text), toks: tokens(text) });
    let next = i + 1;
    while (next < segs.length && segs[next].t < start + STEP) next++;
    i = next;
  }
  return chunks;
}

const matches = (tok: string, term: string) => tok === term || (term.length >= 3 && tok.startsWith(term));

export async function youtubeSearch(
  params: { query: string; max_videos?: number; max_results?: number; language?: string },
  env: Env
): Promise<string> {
  const query = params.query.trim();
  const nVideos = Math.min(Math.max(params.max_videos ?? 6, 1), 10);
  const nResults = Math.min(Math.max(params.max_results ?? 5, 1), 10);
  const hasArabic = /[\u0600-\u06FF]/.test(query);
  const langs = params.language ? [params.language] : hasArabic ? ["ar", "en"] : ["en", "ar"];

  let videos: Video[];
  let via = "InnerTube (no key)";
  try {
    if (env.YOUTUBE_API_KEY) {
      via = "YouTube Data API";
      videos = await searchApi(query, nVideos, env.YOUTUBE_API_KEY);
    } else {
      videos = await searchInnerTube(query, nVideos);
    }
  } catch (e: any) {
    return `ERROR: video search failed (${via}): ${e?.message ?? e}`;
  }
  if (!videos.length) return `No videos found (${via}).`;

  const settled = await Promise.allSettled(videos.map((v) => getSegments(v.id, langs)));
  const chunks: Chunk[] = [];
  const failed: string[] = [];
  settled.forEach((s, idx) => {
    const v = videos[idx];
    if (s.status === "fulfilled") chunks.push(...makeChunks(v, s.value));
    else failed.push(`- ${v.title} (${v.id}): ${s.reason?.message ?? s.reason}`);
  });

  if (!chunks.length) {
    return `Found ${videos.length} videos via ${via} but could not read any transcript:\n${failed.join("\n")}`;
  }

  let terms = [...new Set(tokens(query))];
  const filtered = terms.filter((t) => !STOP.has(t));
  if (filtered.length) terms = filtered;
  const phrase = tokens(query).join(" ");

  // BM25 over all chunks
  const N = chunks.length;
  const avg = chunks.reduce((a, c) => a + c.toks.length, 0) / N || 1;
  const df = new Map<string, number>();
  for (const t of terms) df.set(t, chunks.filter((c) => c.toks.some((k) => matches(k, t))).length);
  const k1 = 1.4;
  const b = 0.6;

  const scored = chunks
    .map((c) => {
      let score = 0;
      let covered = 0;
      for (const t of terms) {
        const tf = c.toks.filter((k) => matches(k, t)).length;
        if (!tf) continue;
        covered++;
        const d = df.get(t) ?? 0;
        const idf = Math.log(1 + (N - d + 0.5) / (d + 0.5));
        score += (idf * (tf * (k1 + 1))) / (tf + k1 * (1 - b + (b * c.toks.length) / avg));
      }
      if (!covered) return { c, score: 0 };
      score += (covered / terms.length) * 2;
      if (phrase && c.toks.join(" ").includes(phrase)) score += 3;
      const titleNorm = norm(c.v.title);
      for (const t of terms) if (titleNorm.includes(t)) score += 0.4;
      return { c, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b2) => b2.score - a.score);

  if (!scored.length) {
    return `Read transcripts of ${videos.length - failed.length} videos but none mentioned the query.` +
      (failed.length ? `\nTranscript failures:\n${failed.join("\n")}` : "");
  }

  const picked: { c: Chunk; score: number; t: number }[] = [];
  for (const s of scored) {
    // exact moment: first segment in the chunk with the most query terms
    let best = s.c.segs[0];
    let bestN = -1;
    for (const sg of s.c.segs) {
      const tk = tokens(sg.text);
      const n = terms.filter((t) => tk.some((k) => matches(k, t))).length;
      if (n > bestN) {
        bestN = n;
        best = sg;
      }
    }
    const t = Math.max(0, best.t - 2);
    const same = picked.filter((p) => p.c.v.id === s.c.v.id);
    if (same.length >= 3 || same.some((p) => Math.abs(p.t - t) < 60)) continue;
    picked.push({ ...s, t });
    if (picked.length >= nResults) break;
  }

  const lines = picked.map((p, i) => {
    const sec = Math.floor(p.t);
    const snippet = p.c.text.length > 350 ? p.c.text.slice(0, 350) + "…" : p.c.text;
    return (
      `${i + 1}) ${p.c.v.title} — ${p.c.v.channel}\n` +
      `   ⏱ ${fmt(sec)} → https://www.youtube.com/watch?v=${p.c.v.id}&t=${sec}s\n` +
      `   "${snippet}"`
    );
  });

  let out = `Results for "${query}" (search via ${via}, ${videos.length - failed.length}/${videos.length} transcripts read):\n\n${lines.join("\n\n")}`;
  if (failed.length) out += `\n\nVideos without a usable transcript:\n${failed.join("\n")}`;
  return out;
}
