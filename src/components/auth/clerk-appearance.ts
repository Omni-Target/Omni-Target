// Shared light-theme Clerk appearance used by sign-in / sign-up / reset pages.
// The card chrome is stripped so the form blends into the AuthShell panel.
// Values mirror the design tokens in globals.css (Clerk needs literal colors).
export const authAppearance = {
  variables: {
    colorBackground: "#ffffff",
    colorInputBackground: "#ffffff",
    colorText: "#0b0d12",
    colorTextSecondary: "#5b6472",
    colorPrimary: "#4f46e5",
    colorInputText: "#0b0d12",
    colorDanger: "#dc2626",
    borderRadius: "0.625rem",
    fontFamily: "var(--font-geist-sans)",
  },
  elements: {
    rootBox: "w-full",
    cardBox: "!shadow-none !border-0 w-full !p-0 !m-0",
    card: "!bg-transparent !shadow-none !border-0 !m-0 !p-0 w-full",
    header: "hidden",
    headerTitle: "hidden",
    headerSubtitle: "hidden",
    formButtonPrimary:
      "bg-brand-600 hover:bg-brand-700 text-white rounded-lg font-medium shadow-sm normal-case text-sm py-2.5 transition-colors",
    socialButtonsBlockButton:
      "border-border text-foreground hover:bg-surface-subtle rounded-lg transition-colors",
    socialButtonsBlockButtonText: "font-medium text-foreground",
    formFieldInput:
      "border-border text-foreground bg-surface focus:border-brand-500 focus:ring-4 focus:ring-brand-500/15 rounded-lg h-11 transition-all",
    otpCodeFieldInput: "border-border text-foreground",
    formFieldLabel: "text-foreground text-sm font-medium",
    footerActionText: "text-muted-foreground",
    footerActionLink: "text-brand-600 hover:text-brand-700 font-semibold",
    identityPreviewText: "text-foreground",
    identityPreviewEditButtonIcon: "text-brand-600",
    dividerLine: "bg-border",
    dividerText: "text-faint-foreground text-xs uppercase tracking-wide",
    formFieldInputShowPasswordButton: "text-subtle-foreground",
  },
};
