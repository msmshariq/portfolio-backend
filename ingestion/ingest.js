import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const INDEX_NAME = process.env.VECTORIZE_INDEX_NAME;
const CF_BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/vectorize/v2/indexes/${INDEX_NAME}`;

const SOURCES = {
  cv: "../data/cv.md",
  linkedin: "../data/linkedin.md",
  recommendations: "../data/recommendations.md",
};

const MAX_CHUNK_CHARS = 1500;
const CHUNK_OVERLAP = 200;

// Splits markdown by ## headings, then further splits oversized sections.
// Each chunk always carries its section heading for context.
function chunkText(text, source) {
  const chunks = [];
  let chunkIndex = 0;

  const sections = text.split(/(?=^#{1,3} )/m).filter((s) => s.trim().length > 50);

  for (const section of sections) {
    const heading = section.match(/^(#{1,3} .+)/m)?.[1] ?? "";

    if (section.length <= MAX_CHUNK_CHARS) {
      chunks.push({
        id: `${source}-chunk-${chunkIndex++}`,
        text: section.trim(),
        metadata: { source },
      });
    } else {
      let start = 0;
      while (start < section.length) {
        const end = Math.min(start + MAX_CHUNK_CHARS, section.length);
        const sliceText = start === 0
          ? section.slice(start, end).trim()
          : `${heading}\n\n${section.slice(start, end).trim()}`;

        chunks.push({
          id: `${source}-chunk-${chunkIndex++}`,
          text: sliceText,
          metadata: { source },
        });
        start += MAX_CHUNK_CHARS - CHUNK_OVERLAP;
      }
    }
  }

  return chunks;
}

async function embed(text) {
  const res = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: text,
  });
  return res.data[0].embedding;
}

async function cfFetch(urlPath, method, body, contentType = "application/json") {
  const res = await fetch(`${CF_BASE}${urlPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      "Content-Type": contentType,
    },
    body,
  });
  const json = await res.json();
  if (!json.success) {
    throw new Error(
      `Cloudflare API error: ${JSON.stringify(json.errors || json.messages || json)}`
    );
  }
  return json;
}

async function deleteVectorsForSource(source) {
  const filePath = path.resolve(__dirname, SOURCES[source]);
  if (!fs.existsSync(filePath)) return;

  const text = fs.readFileSync(filePath, "utf-8");
  const chunks = chunkText(text, source);
  const ids = chunks.map((c) => c.id);

  if (ids.length === 0) return;

  console.log(`  Deleting ${ids.length} existing vectors for source: ${source}`);
  // Vectorize v2 REST endpoint for bulk delete is /delete-by-ids (mirrors the Worker binding's deleteByIds())
  await cfFetch("/delete-by-ids", "POST", JSON.stringify({ ids }), "application/json");
}

async function ingestSource(source) {
  const filePath = path.resolve(__dirname, SOURCES[source]);
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  console.log(`\nIngesting: ${source}`);

  await deleteVectorsForSource(source);

  const text = fs.readFileSync(filePath, "utf-8");
  const chunks = chunkText(text, source);

  console.log(`  Chunked into ${chunks.length} pieces, embedding...`);

  const vectors = [];
  for (const chunk of chunks) {
    const values = await embed(chunk.text);
    vectors.push({
      id: chunk.id,
      values,
      metadata: { source: chunk.metadata.source, text: chunk.text },
    });
    process.stdout.write(".");
  }
  console.log();

  const ndjson = vectors.map((v) => JSON.stringify(v)).join("\n");
  await cfFetch("/upsert", "POST", ndjson, "application/x-ndjson");

  console.log(`  Upserted ${vectors.length} vectors for source: ${source}`);
}

async function main() {
  const arg = process.argv[2];

  if (!ACCOUNT_ID || !API_TOKEN || !INDEX_NAME) {
    console.error("Missing env vars — check your .env file.");
    process.exit(1);
  }

  const targets = arg === "--source=all" || !arg
    ? Object.keys(SOURCES)
    : [arg.replace("--source=", "")];

  for (const source of targets) {
    if (!SOURCES[source]) {
      console.error(`Unknown source: ${source}. Valid options: ${Object.keys(SOURCES).join(", ")}, all`);
      process.exit(1);
    }
    await ingestSource(source);
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
