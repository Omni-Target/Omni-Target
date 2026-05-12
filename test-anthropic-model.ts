import { Anthropic } from '@anthropic-ai/sdk';
import 'dotenv/config';

async function test() {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  try {
    const res = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 10,
      messages: [{ role: "user", content: "Hello" }]
    });
    console.log("Success:", res.id);
  } catch (e: any) {
    console.log("Anthropic Error:", e.message);
  }
}
test();
