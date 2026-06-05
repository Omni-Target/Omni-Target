export default function Loading() {
  return (
    <div className="min-h-screen bg-[var(--background)] px-4 py-12 pb-28 sm:pb-12 sm:px-6 lg:px-8">
      <div className="max-w-2xl mx-auto flex justify-center py-20">
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 rounded-full border-2 border-brand-500 border-t-transparent animate-spin"></div>
          <span className="text-white/50 text-sm">Loading settings...</span>
        </div>
      </div>
    </div>
  );
}
