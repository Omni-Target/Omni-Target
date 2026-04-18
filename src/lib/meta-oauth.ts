export const META_REDIRECT_URI = 
  `${(process.env.NEXT_PUBLIC_APP_URL || "").replace(/\/$/, "")}` +
  `/api/auth/meta/callback`;

console.log("META_REDIRECT_URI resolved:", META_REDIRECT_URI);
