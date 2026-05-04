import Anthropic from '@anthropic-ai/sdk';

async function test() {
  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY
  });
  
  try {
    const res = await client.messages.create({
      model: "claude-4-5-sonnet",
      max_tokens: 10,
      messages: [{role: "user", content: "hi"}]
    });
    console.log(res);
  } catch(err) {
    console.error("Error:", err);
  }
}

test();
