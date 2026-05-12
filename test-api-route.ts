import fetch from 'node-fetch';

async function test() {
  const url = "http://localhost:3000/api/campaigns/generate";
  const body = {
    brandName: "K|KASA",
    productName: "Kiss & Tell",
    productDescription: "A mini ribbed slip dress...",
    targetAudience: "Broad",
    campaignGoal: "Drive Website Sales",
    tonePreference: "Let AI decide",
    imageUrl: "https://cdn.shopify.com/s/files/1/0688/1755/1382/products/IMG_3962.jpg?v=1671042301" // Example Shopify URL
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    
    console.log("Status:", res.status);
    const text = await res.text();
    console.log("Response:", text);
  } catch(e) {
    console.log("Fetch Error:", e);
  }
}
test();
