import bioContent from "../../data/bio.md";

interface Env {
  VECTORIZE: VectorizeIndex;
  OPENAI_API_KEY: string;
}

interface ChatMessage {
  role: string;
  content: string;
}

interface ChatRequest {
  message: string;
  sessionId?: string;
  history?: ChatMessage[];
}

const ALLOWED_ORIGINS = [
  "https://msmshariq.com",
  "https://www.msmshariq.com",
  "http://localhost:3000",
];

function corsHeaders(origin: string | null): Record<string, string> {
  const allowed =
    origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

async function embedText(text: string, apiKey: string): Promise<number[]> {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: "text-embedding-3-small", input: text }),
  });
  const data = (await res.json()) as { data: [{ embedding: number[] }] };
  return data.data[0].embedding;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get("Origin");
    const cors = corsHeaders(origin);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);

    if (request.method !== "POST" || url.pathname !== "/chat") {
      return new Response("Not found", { status: 404, headers: cors });
    }

    try {
      const body = (await request.json()) as ChatRequest;
      const { message, history = [] } = body;

      if (!message?.trim()) {
        return new Response(JSON.stringify({ error: "Message is required" }), {
          status: 400,
          headers: { ...cors, "Content-Type": "application/json" },
        });
      }

      // Embed the user query and retrieve relevant context
      const queryVector = await embedText(message, env.OPENAI_API_KEY);
      const results = await env.VECTORIZE.query(queryVector, {
        topK: 5,
        returnMetadata: "all",
      });

      const context = results.matches
        .map((m) => (m.metadata as Record<string, string>)?.text ?? "")
        .filter(Boolean)
        .join("\n\n---\n\n");

      // Build prompt: bio as system prompt + retrieved context + conversation history
      const systemPrompt = `${bioContent}\n\n## Relevant Context\n\n${context}`;

      const messages = [
        { role: "system", content: systemPrompt },
        ...history.map((h) => ({ role: h.role, content: h.content })),
        { role: "user", content: message },
      ];

      // Stream from OpenAI
      const openaiRes = await fetch(
        "https://api.openai.com/v1/chat/completions",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.OPENAI_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "gpt-5.4-mini",
            messages,
            stream: true,
            max_tokens: 1024,
            temperature: 0.7,
          }),
        }
      );

      if (!openaiRes.ok) {
        const err = await openaiRes.text();
        throw new Error(`OpenAI error: ${err}`);
      }

      // Transform OpenAI SSE → our SSE (plain token chunks)
      const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();

      (async () => {
        const reader = openaiRes.body!.getReader();
        let buffer = "";
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";

            for (const line of lines) {
              if (!line.startsWith("data: ")) continue;
              const data = line.slice(6).trim();
              if (data === "[DONE]") {
                await writer.write(encoder.encode("data: [DONE]\n\n"));
                return;
              }
              try {
                const parsed = JSON.parse(data);
                const token = parsed.choices?.[0]?.delta?.content ?? "";
                if (token) {
                  // JSON-encode token so newlines in responses don't break SSE framing
                  await writer.write(
                    encoder.encode(`data: ${JSON.stringify(token)}\n\n`)
                  );
                }
              } catch {}
            }
          }
        } finally {
          await writer.close().catch(() => {});
        }
      })();

      return new Response(readable, {
        headers: {
          ...cors,
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        },
      });
    } catch (err) {
      console.error(err);
      return new Response(JSON.stringify({ error: "Internal server error" }), {
        status: 500,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }
  },
};
