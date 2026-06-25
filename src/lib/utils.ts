// Simple className utility — no external deps needed
export function cn(...inputs: (string | undefined | null | false | Record<string, boolean>)[]) {
  return inputs
    .filter(Boolean)
    .map((input) => {
      if (typeof input === "string") return input;
      if (typeof input === "object" && input !== null) {
        return Object.entries(input)
          .filter(([, v]) => v)
          .map(([k]) => k)
          .join(" ");
      }
      return "";
    })
    .join(" ")
    .trim();
}
