import fetch from 'node-fetch';

async function test() {
  const url = "https://res.cloudinary.com/doyrjsnnt/image/upload/v1746401018/omni_campaigns/1778606763865_video.jpg";
  const res = await fetch(url);
  console.log("Status:", res.status);
}
test();
