// Shared light-theme Clerk appearance used by sign-in / sign-up / reset pages.
// The card chrome is stripped so the form blends into the AuthShell panel.
export const authAppearance = {
  variables: {
    colorBackground: "#ffffff",
    colorInputBackground: "#ffffff",
    colorText: "#0b0d12",
    colorTextSecondary: "#5b6472",
    colorPrimary: "#09090f",
    colorInputText: "#0b0d12",
    colorDanger: "#dc2626",
    borderRadius: "0.625rem",
    fontFamily: "var(--font-geist-sans)",
  },
  elements: {
    rootBox: "w-full",
    cardBox: "shadow-none border-0 w-full",
    card: "bg-transparent shadow-none m-0 p-0",
    headerTitle: "text-foreground font-semibold text-xl",
    headerSubtitle: "text-muted-foreground",
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
